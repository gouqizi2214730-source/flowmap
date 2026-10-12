"""Black-Scholes option gamma exposure under explicit model assumptions.

Call/put signs assume positive call and negative put exposure; open interest
cannot reveal actual dealer positions. The reported scale is Gamma * OI *
100-contract multiplier * spot**2, per unit relative spot move. Multiply by
0.01 for the model's one-percent spot-move sensitivity. Walls are maxima of
modelled call/put contributions, and a flip requires an observed sign bracket.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime
import logging
import math
from typing import Any

log = logging.getLogger(__name__)
_SQRT_2PI = math.sqrt(2.0 * math.pi)
_DEFAULT_RISK_FREE_RATE = 0.045  # Fixed model assumption, not a current market quote.


def _finite(value: object) -> bool:
    if not isinstance(value, (float, int)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def norm_pdf(x: float) -> float:
    """Standard normal probability density function N'(x)."""
    if not _finite(x):
        raise ValueError('normal density requires a finite value')
    return math.exp(-0.5 * x * x) / _SQRT_2PI


def bs_gamma(spot: float, strike: float, tau: float, iv: float, r: float = _DEFAULT_RISK_FREE_RATE) -> float:
    """European vanilla Black-Scholes gamma, identical for calls and puts."""
    if not all(_finite(value) for value in (spot, strike, tau, iv, r)) or min(spot, strike, tau, iv) <= 0:
        raise ValueError('gamma requires finite positive spot, strike, time and volatility')
    vol_sqrt_t = iv * math.sqrt(tau)
    d1 = (math.log(spot) - math.log(strike) + (r + 0.5 * iv * iv) * tau) / vol_sqrt_t
    denominator = spot * vol_sqrt_t
    if not _finite(d1) or not _finite(denominator) or denominator <= 0:
        raise ValueError('gamma inputs exceed finite numerical range')
    gamma = norm_pdf(d1) / denominator
    if not _finite(gamma):
        raise ValueError('gamma is not finite')
    return gamma


@dataclass(slots=True)
class OptionContract:
    strike: float
    is_call: bool
    open_interest: float
    implied_vol: float
    dte_days: float


@dataclass(slots=True)
class GexResult:
    symbol: str
    spot_price: float | None
    call_wall: float | None
    put_wall: float | None
    gamma_flip: float | None
    net_gex: float | None
    strikes: list[float]
    strike_gex: list[float]
    available: bool = False
    unavailable_reason: str | None = None
    model_provenance: dict[str, Any] = field(default_factory=dict)


def _unavailable(symbol: str, spot: float | None, reason: str) -> GexResult:
    real_spot = float(spot) if _finite(spot) and spot > 0 else None
    return GexResult(symbol.upper(), real_spot, None, None, None, None, [], [],
                     unavailable_reason=reason)


def _valid_contract(opt: OptionContract) -> bool:
    return (isinstance(opt, OptionContract) and isinstance(opt.is_call, bool)
            and all(_finite(value) for value in (opt.strike, opt.open_interest, opt.implied_vol, opt.dte_days))
            and opt.strike > 0 and opt.open_interest >= 0 and opt.implied_vol > 0 and opt.dte_days > 0)


def calculate_gex(symbol: str, spot: float, contracts: list[OptionContract],
                  r: float = _DEFAULT_RISK_FREE_RATE) -> GexResult:
    """Calculate only from finite real inputs; unavailable data has no levels."""
    if not _finite(spot) or spot <= 0 or not _finite(r):
        return _unavailable(symbol, spot, 'invalid spot or risk-free-rate assumption')
    if not contracts or any(not _valid_contract(opt) for opt in contracts):
        return _unavailable(symbol, spot, 'missing or invalid option chain')
    try:
        multiplier = spot * spot * 100.0
        if not _finite(multiplier):
            raise ValueError('GEX multiplier is not finite')
        calls: dict[float, float] = {}
        puts: dict[float, float] = {}
        for opt in contracts:
            contribution = opt.open_interest * bs_gamma(spot, opt.strike, opt.dte_days / 365.0, opt.implied_vol, r) * multiplier
            if not _finite(contribution):
                raise ValueError('GEX contribution is not finite')
            side = calls if opt.is_call else puts
            side[opt.strike] = side.get(opt.strike, 0.0) + contribution
            if not _finite(side[opt.strike]):
                raise ValueError('strike GEX is not finite')
        strikes = sorted(calls.keys() | puts.keys())
        strike_net = [calls.get(k, 0.0) - puts.get(k, 0.0) for k in strikes]
        net = math.fsum(strike_net)
        if not all(_finite(value) for value in [net, *strike_net]):
            raise ValueError('aggregate GEX is not finite')
        positive_calls = {k: value for k, value in calls.items() if value > 0}
        positive_puts = {k: value for k, value in puts.items() if value > 0}
        flip = None
        if positive_calls and positive_puts and strikes[0] < strikes[-1]:
            def at_price(price: float) -> float:
                # The positive spot scaling does not affect the zero's location.
                values = [opt.open_interest * bs_gamma(price, opt.strike, opt.dte_days / 365.0,
                          opt.implied_vol, r) * (1 if opt.is_call else -1) for opt in contracts]
                value = math.fsum(values)
                if not _finite(value):
                    raise ValueError('gamma scan is not finite')
                return value

            low, high = strikes[0], strikes[-1]
            samples = set(strikes)
            samples.update(low + (high - low) * i / 256 for i in range(257))
            if low <= spot <= high:
                samples.add(spot)
            roots = []
            previous = None
            for price in sorted(samples):
                value = at_price(price)
                if value == 0:
                    continue
                if previous is not None and (value > 0) != (previous[1] > 0):
                    left, left_value = previous
                    right = price
                    for _ in range(64):
                        middle = left + (right - left) / 2
                        middle_value = at_price(middle)
                        if middle_value == 0 or right - left <= 1e-10 * max(1.0, middle):
                            break
                        if (middle_value > 0) == (left_value > 0):
                            left, left_value = middle, middle_value
                        else:
                            right = middle
                    roots.append(middle)
                previous = (price, value)
            if roots:
                flip = min(roots, key=lambda level: abs(level - spot))
        return GexResult(
            symbol=symbol.upper(), spot_price=float(spot),
            call_wall=max(positive_calls, key=positive_calls.get) if positive_calls else None,
            put_wall=max(positive_puts, key=positive_puts.get) if positive_puts else None,
            gamma_flip=flip, net_gex=net, strikes=strikes, strike_gex=strike_net,
            available=True, model_provenance={
                'model': 'Black-Scholes European vanilla gamma',
                'risk_free_rate': float(r), 'risk_free_rate_source': 'fixed model assumption',
                'contract_multiplier': 100,
                'scale': 'dollar delta-notional sensitivity per unit relative spot move',
                'dealer_position_convention': 'positive calls, negative puts; actual positions unknown',
                'options_source': 'caller-supplied option chain',
            },
        )
    except (ValueError, OverflowError, ZeroDivisionError) as exc:
        return _unavailable(symbol, spot, str(exc))


async def fetch_options_and_calculate_gex(symbol: str, spot_price: float | None = None) -> GexResult:
    """Fetch actual Yahoo option inputs; never invent prices, IV or contracts."""
    loop = asyncio.get_running_loop()

    def fetch() -> GexResult:
        current_spot = spot_price
        if current_spot is not None and (not _finite(current_spot) or current_spot <= 0):
            return _unavailable(symbol, current_spot, 'invalid supplied spot')
        try:
            import yfinance as yf
            ticker = yf.Ticker(symbol.upper())
            if current_spot is None:
                current_spot = float(ticker.fast_info.last_price)
            if not _finite(current_spot) or current_spot <= 0:
                return _unavailable(symbol, current_spot, 'missing or invalid source price')
            expirations = ticker.options[:6]
            contracts: list[OptionContract] = []
            today = datetime.now(UTC).date()
            for expiration in expirations:
                dte = (datetime.strptime(expiration, '%Y-%m-%d').date() - today).days
                if dte <= 0:
                    continue
                chain = ticker.option_chain(expiration)
                for is_call, frame in ((True, chain.calls), (False, chain.puts)):
                    for _, row in frame.iterrows():
                        oi = float(row.get('openInterest'))
                        if not _finite(oi) or oi < 0:
                            return _unavailable(symbol, current_spot, 'missing or invalid source open interest')
                        if oi == 0:
                            continue
                        opt = OptionContract(float(row['strike']), is_call, oi,
                                             float(row.get('impliedVolatility')), dte)
                        if not _valid_contract(opt):
                            return _unavailable(symbol, current_spot, 'missing or invalid source option inputs')
                        contracts.append(opt)
            result = calculate_gex(symbol, current_spot, contracts)
            if result.available:
                result.model_provenance['options_source'] = 'yfinance option chain, first six expirations'
                result.model_provenance['spot_source'] = 'caller supplied' if spot_price is not None else 'yfinance fast_info.last_price'
            return result
        except Exception as exc:
            log.warning('Could not obtain valid option inputs for %s: %s', symbol, exc)
            return _unavailable(symbol, current_spot, 'option source unavailable or invalid')

    return await loop.run_in_executor(None, fetch)
