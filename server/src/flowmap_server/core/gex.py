"""Gamma Exposure (GEX) quantitative calculation engine (FLOW <GO>).

Computes market-maker option gamma exposure, volatility boundaries, and pin levels:
1. Black-Scholes Gamma (Γ) for calls and puts:
   Γ = N'(d1) / (S * σ * sqrt(τ))
   where d1 = (ln(S / K) + (r + 0.5 * σ^2) * τ) / (σ * sqrt(τ))
2. Net Gamma Exposure ($ per 1% or $ spot move):
   Call GEX = Call OI * Γ * S^2 * 100
   Put GEX  = - Put OI * Γ * S^2 * 100
   Net GEX  = Call GEX + Put GEX
3. Call Wall: Strike with maximum positive Call GEX (volatility ceiling / resistance).
4. Put Wall: Strike with maximum negative Put GEX (volatility floor / support / breakdown trigger).
5. Gamma Flip: Zero-gamma inflection level where dealer hedging flips from stabilizing (long gamma)
   to accelerating (short gamma).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import logging
import math
from typing import Any

log = logging.getLogger(__name__)

_SQRT_2PI = math.sqrt(2.0 * math.pi)
_DEFAULT_RISK_FREE_RATE = 0.045  # 4.5% US Treasury risk-free rate


def norm_pdf(x: float) -> float:
    """Standard normal probability density function N'(x)."""
    return math.exp(-0.5 * x * x) / _SQRT_2PI


def bs_gamma(spot: float, strike: float, tau: float, iv: float, r: float = _DEFAULT_RISK_FREE_RATE) -> float:
    """Calculate Black-Scholes gamma for European/American vanilla options.

    Gamma is identical for both calls and puts under Black-Scholes.
    """
    if spot <= 0.0 or strike <= 0.0 or tau <= 0.0001 or iv <= 0.0001:
        return 0.0

    vol_sqrt_t = iv * math.sqrt(tau)
    d1 = (math.log(spot / strike) + (r + 0.5 * iv * iv) * tau) / vol_sqrt_t
    return norm_pdf(d1) / (spot * vol_sqrt_t)


@dataclass(slots=True)
class OptionContract:
    strike: float
    is_call: bool
    open_interest: float
    implied_vol: float
    dte_days: float  # days to expiration


@dataclass(slots=True)
class GexResult:
    symbol: str
    spot_price: float
    call_wall: float
    put_wall: float
    gamma_flip: float
    net_gex: float
    strikes: list[float]
    strike_gex: list[float]


def calculate_gex(
    symbol: str,
    spot: float,
    contracts: list[OptionContract],
    r: float = _DEFAULT_RISK_FREE_RATE,
) -> GexResult:
    """Calculate aggregate and strike-level GEX from option contracts."""
    if spot <= 0.0 or not contracts:
        return GexResult(
            symbol=symbol.upper(),
            spot_price=spot,
            call_wall=spot,
            put_wall=spot,
            gamma_flip=spot,
            net_gex=0.0,
            strikes=[],
            strike_gex=[],
        )

    # Accumulate gamma by strike
    strike_call_gex: dict[float, float] = {}
    strike_put_gex: dict[float, float] = {}
    total_net_gex = 0.0

    multiplier = spot * spot * 100.0  # dollar gamma per 100% move

    for opt in contracts:
        tau = max(opt.dte_days / 365.0, 0.001)
        gamma = bs_gamma(spot, opt.strike, tau, opt.implied_vol, r)
        gex_val = opt.open_interest * gamma * multiplier

        if opt.is_call:
            strike_call_gex[opt.strike] = strike_call_gex.get(opt.strike, 0.0) + gex_val
            total_net_gex += gex_val
        else:
            strike_put_gex[opt.strike] = strike_put_gex.get(opt.strike, 0.0) + gex_val
            total_net_gex -= gex_val

    all_strikes = sorted(set(strike_call_gex.keys()) | set(strike_put_gex.keys()))

    if not all_strikes:
        return GexResult(
            symbol=symbol.upper(),
            spot_price=spot,
            call_wall=spot,
            put_wall=spot,
            gamma_flip=spot,
            net_gex=0.0,
            strikes=[],
            strike_gex=[],
        )

    # Call Wall: strike with maximum call gamma
    call_wall = max(all_strikes, key=lambda k: strike_call_gex.get(k, 0.0))

    # Put Wall: strike with maximum put gamma
    put_wall = max(all_strikes, key=lambda k: strike_put_gex.get(k, 0.0))

    # Net GEX per strike
    strike_net: list[float] = [
        strike_call_gex.get(k, 0.0) - strike_put_gex.get(k, 0.0) for k in all_strikes
    ]

    # Gamma Flip level: find zero-crossing interpolation around spot price
    gamma_flip = spot
    # Search spot levels in range [min_strike, max_strike]
    min_s = min(all_strikes)
    max_s = max(all_strikes)
    steps = 40
    step_sz = (max_s - min_s) / steps if max_s > min_s else 1.0

    best_zero = float("inf")
    found_flip = spot

    for i in range(steps + 1):
        s_test = min_s + i * step_sz
        sim_mult = s_test * s_test * 100.0
        sim_net = 0.0
        for opt in contracts:
            tau = max(opt.dte_days / 365.0, 0.001)
            g = bs_gamma(s_test, opt.strike, tau, opt.implied_vol, r)
            if opt.is_call:
                sim_net += opt.open_interest * g * sim_mult
            else:
                sim_net -= opt.open_interest * g * sim_mult

        if abs(sim_net) < best_zero:
            best_zero = abs(sim_net)
            found_flip = s_test

    gamma_flip = round(found_flip, 2)

    return GexResult(
        symbol=symbol.upper(),
        spot_price=spot,
        call_wall=call_wall,
        put_wall=put_wall,
        gamma_flip=gamma_flip,
        net_gex=round(total_net_gex, 2),
        strikes=all_strikes,
        strike_gex=strike_net,
    )


async def fetch_options_and_calculate_gex(
    symbol: str,
    spot_price: float | None = None,
) -> GexResult:
    """Fetch option chain (via yfinance or fallback) and compute GEX metrics."""
    loop = asyncio.get_running_loop()

    def _sync_fetch() -> GexResult:
        import yfinance as yf

        sym = symbol.upper()
        ticker = yf.Ticker(sym)
        try:
            fast_info = ticker.fast_info
            current_spot = spot_price or float(fast_info.last_price or 100.0)
        except Exception:
            current_spot = spot_price or 100.0

        contracts: list[OptionContract] = []
        try:
            expirations = ticker.options[:6]  # First 6 expiries for near-term gamma
            from datetime import UTC, datetime

            now = datetime.now(UTC).date()

            for exp in expirations:
                try:
                    exp_date = datetime.strptime(exp, "%Y-%m-%d").date()
                    dte = max((exp_date - now).days, 1)
                    chain = ticker.option_chain(exp)

                    for _, row in chain.calls.iterrows():
                        oi = float(row.get("openInterest") or 0.0)
                        iv = float(row.get("impliedVolatility") or 0.25)
                        strike = float(row["strike"])
                        if oi > 0:
                            contracts.append(
                                OptionContract(
                                    strike=strike,
                                    is_call=True,
                                    open_interest=oi,
                                    implied_vol=iv,
                                    dte_days=dte,
                                )
                            )

                    for _, row in chain.puts.iterrows():
                        oi = float(row.get("openInterest") or 0.0)
                        iv = float(row.get("impliedVolatility") or 0.25)
                        strike = float(row["strike"])
                        if oi > 0:
                            contracts.append(
                                OptionContract(
                                    strike=strike,
                                    is_call=False,
                                    open_interest=oi,
                                    implied_vol=iv,
                                    dte_days=dte,
                                )
                            )
                except Exception as exc:
                    log.debug("Skipping option expiry %s for %s: %s", exp, sym, exc)
        except Exception as exc:
            log.warning("Could not fetch real options chain for %s: %s. Using synthetic model.", sym, exc)

        if not contracts:
            # Synthetic standard distribution around spot
            for offset in [-15, -10, -5, 0, 5, 10, 15]:
                k = round(current_spot * (1.0 + offset / 100.0), 2)
                contracts.append(
                    OptionContract(strike=k, is_call=True, open_interest=1000.0, implied_vol=0.25, dte_days=14)
                )
                contracts.append(
                    OptionContract(strike=k, is_call=False, open_interest=1200.0, implied_vol=0.25, dte_days=14)
                )

        return calculate_gex(sym, current_spot, contracts)

    return await loop.run_in_executor(None, _sync_fetch)
