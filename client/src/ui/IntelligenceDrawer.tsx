/**
 * IntelligenceDrawer (§Terminal Intelligence <GO>).
 *
 * Multi-module deep market analytics terminal drawer:
 * - DOCS <GO>: SEC EDGAR Item 1A Risk Factors sentence diffs & Earnings Call vocal stress acoustic scores.
 * - GOV <GO>: USASpending.gov defense contract awards & Capitol Hill congressional trades.
 * - FLOW <GO>: Gamma Exposure (GEX) boundaries (Call Wall, Put Wall, Gamma Flip) & FINRA TRF dark pool short ratios.
 * - GEO  <GO>: Corporate Jet ADS-B movements (OpenSky M&A hub telemetry) & Talent Velocity headcount momentum.
 * - MACRO <GO>: SOFR, US High Yield OAS spread, and 10Y-2Y yield curve inversion regime.
 */

import { useEffect, useRef, useState } from 'react';
import { useIntelligenceStore, type IntelTab } from '../state/intelligenceStore';
import { useFlowMapStore } from '../state/store';
import './IntelligenceDrawer.css';

interface IntelligenceDrawerProps {
  activeSymbol: string;
  onClose: () => void;
}

export function IntelligenceDrawer({ activeSymbol, onClose }: IntelligenceDrawerProps) {
  const activeTab = useIntelligenceStore((s) => s.activeTab);
  const setActiveTab = useIntelligenceStore((s) => s.setActiveTab);

  const gexMap = useIntelligenceStore((s) => s.gex);
  const darkPoolMap = useIntelligenceStore((s) => s.darkPool);
  const secDiffs = useIntelligenceStore((s) => s.secDiffs);
  const vocalStress = useIntelligenceStore((s) => s.vocalStress);
  const contracts = useIntelligenceStore((s) => s.contracts);
  const capitolTrades = useIntelligenceStore((s) => s.capitolTrades);
  const corporateJets = useIntelligenceStore((s) => s.corporateJets);
  const talentMap = useIntelligenceStore((s) => s.talent);
  const macro = useIntelligenceStore((s) => s.macro);

  const [filterActiveSymbol, setFilterActiveSymbol] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const sym = activeSymbol.toUpperCase();
  const currentGex = gexMap[sym] ?? gexMap['SIM-DEMO'] ?? null;
  const currentDarkPool = darkPoolMap[sym] ?? darkPoolMap['SIM-DEMO'] ?? null;
  const currentTalent = talentMap[sym] ?? talentMap['SIM-DEMO'] ?? null;

  const filteredDiffs = filterActiveSymbol ? secDiffs.filter((d) => d.symbol === sym) : secDiffs;
  const filteredStress = filterActiveSymbol ? vocalStress.filter((v) => v.symbol === sym) : vocalStress;
  const filteredContracts = filterActiveSymbol ? contracts.filter((c) => c.symbol === sym) : contracts;
  const filteredTrades = filterActiveSymbol ? capitolTrades.filter((t) => t.symbol === sym) : capitolTrades;
  const filteredJets = filterActiveSymbol ? corporateJets.filter((j) => j.symbol === sym) : corporateJets;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        ref={drawerRef}
        className="drawer intel-drawer"
        role="dialog"
        aria-label="Intelligence Terminal"
        aria-modal="true"
        data-testid="intelligence-drawer"
      >
        <div className="drawer__header intel-drawer__header">
          <div className="intel-drawer__title-group">
            <span className="intel-drawer__badge">⚡ DEEP INTELLIGENCE &lt;GO&gt;</span>
            <h2 className="drawer__title intel-drawer__title">Institutional Terminal Alpha</h2>
          </div>
          <button
            type="button"
            className="drawer__close"
            onClick={onClose}
            aria-label="Close intelligence drawer"
            data-testid="intel-drawer-close"
          >
            ✕
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="intel-drawer__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'DOCS'}
            className={`intel-tab${activeTab === 'DOCS' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('DOCS')}
            data-testid="tab-docs"
          >
            DOCS &lt;GO&gt;
            <span className="intel-tab__hint">SEC & Acoustic</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'GOV'}
            className={`intel-tab${activeTab === 'GOV' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('GOV')}
            data-testid="tab-gov"
          >
            GOV &lt;GO&gt;
            <span className="intel-tab__hint">DoD & Capitol</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'FLOW'}
            className={`intel-tab${activeTab === 'FLOW' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('FLOW')}
            data-testid="tab-flow"
          >
            FLOW &lt;GO&gt;
            <span className="intel-tab__hint">Dark Pools & GEX</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'GEO'}
            className={`intel-tab${activeTab === 'GEO' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('GEO')}
            data-testid="tab-geo"
          >
            GEO &lt;GO&gt;
            <span className="intel-tab__hint">Jets & Talent</span>
          </button>
        </div>

        {/* Active Symbol Context & Filter Switch */}
        <div className="intel-drawer__context-bar">
          <span className="intel-drawer__target">
            ACTIVE SYMBOL: <strong>{sym}</strong>
          </span>
          <button
            type="button"
            className={`intel-filter-toggle${filterActiveSymbol ? ' is-on' : ''}`}
            onClick={() => setFilterActiveSymbol(!filterActiveSymbol)}
          >
            {filterActiveSymbol ? `Filter: ${sym} only` : 'Show all universe'}
          </button>
        </div>

        <div className="drawer__body intel-drawer__body">
          {/* TAB 1: DOCS <GO> */}
          {activeTab === 'DOCS' && (
            <div className="intel-tab-pane" data-testid="pane-docs">
              <section className="intel-section">
                <div className="intel-section__head">
                  <span className="intel-section__tag">SEC EDGAR 10-K / 10-Q ITEM 1A</span>
                  <h3 className="intel-section__title">Risk Factors Semantic Diff Engine</h3>
                </div>
                <p className="intel-section__desc">
                  Real-time sentence-level unified diffing against prior quarterly filings. Highlights material
                  investigations, subpoenas, and operational vulnerabilities.
                </p>

                {filteredDiffs.length === 0 ? (
                  <div className="intel-empty">No SEC Risk Factor changes detected for {sym}.</div>
                ) : (
                  filteredDiffs.map((diff) => (
                    <article key={diff.id} className="intel-card intel-card--diff">
                      <div className="intel-card__top">
                        <span className="intel-card__sym">{diff.symbol}</span>
                        <span className="intel-card__form">{diff.filingType}</span>
                        <span className="intel-card__date">{diff.filedDate}</span>
                      </div>
                      <div className="intel-card__heading">{diff.title}</div>
                      {diff.criticalTriggers.length > 0 && (
                        <div className="intel-triggers">
                          {diff.criticalTriggers.map((trig) => (
                            <span key={trig} className="intel-trigger-badge">
                              ⚠️ {trig}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="intel-diff-box">
                        {diff.removedLines.map((line, idx) => (
                          <div key={idx} className="diff-line diff-line--del">
                            {line}
                          </div>
                        ))}
                        {diff.addedLines.map((line, idx) => (
                          <div key={idx} className="diff-line diff-line--add">
                            {line}
                          </div>
                        ))}
                      </div>
                    </article>
                  ))
                )}
              </section>

              <section className="intel-section">
                <div className="intel-section__head">
                  <span className="intel-section__tag">EARNINGS CALL ACOUSTICS</span>
                  <h3 className="intel-section__title">Vocal Stress & Deception Telemetry</h3>
                </div>
                <p className="intel-section__desc">
                  Q&amp;A acoustic pitch jitter (F0), shimmer, and micro-hesitation ratio extracted via Praat/Parselmouth.
                </p>

                {filteredStress.map((voc) => {
                  const pct = Math.round(voc.stressScore * 100);
                  const isHigh = voc.stressScore >= 0.6;
                  return (
                    <article key={voc.id} className="intel-card intel-card--vocal">
                      <div className="intel-card__top">
                        <span className="intel-card__sym">{voc.symbol}</span>
                        <span className="intel-card__speaker">{voc.executive}</span>
                        <span className="intel-card__date">{voc.quarter}</span>
                      </div>
                      <div className="vocal-metrics-grid">
                        <div className="vocal-metric">
                          <span className="vocal-metric__lbl">STRESS INDEX</span>
                          <span className={`vocal-metric__val${isHigh ? ' is-alert' : ''}`}>
                            {pct}%
                          </span>
                        </div>
                        <div className="vocal-metric">
                          <span className="vocal-metric__lbl">PITCH JITTER (F0)</span>
                          <span className="vocal-metric__val">{(voc.f0Jitter * 100).toFixed(2)}%</span>
                        </div>
                        <div className="vocal-metric">
                          <span className="vocal-metric__lbl">SHIMMER</span>
                          <span className="vocal-metric__val">{(voc.shimmer * 100).toFixed(2)}%</span>
                        </div>
                        <div className="vocal-metric">
                          <span className="vocal-metric__lbl">PAUSE RATIO</span>
                          <span className="vocal-metric__val">{(voc.pauseRatio * 100).toFixed(1)}%</span>
                        </div>
                      </div>
                      {voc.evasiveAnswersDetected > 0 && (
                        <div className="intel-triggers">
                          <span className="intel-trigger-badge is-warn">
                            🚨 {voc.evasiveAnswersDetected} Non-Answers / Deflections Detected during Analyst Q&amp;A
                          </span>
                        </div>
                      )}
                    </article>
                  );
                })}
              </section>
            </div>
          )}

          {/* TAB 2: GOV <GO> */}
          {activeTab === 'GOV' && (
            <div className="intel-tab-pane" data-testid="pane-gov">
              <section className="intel-section">
                <div className="intel-section__head">
                  <span className="intel-section__tag">USASpending.gov DoD AWARDS</span>
                  <h3 className="intel-section__title">Government &amp; Defense Contracts</h3>
                </div>
                <p className="intel-section__desc">
                  Live official federal procurement allocations matched against FlowMap defense &amp; tech tickers.
                </p>

                {filteredContracts.map((c) => (
                  <article key={c.id} className="intel-card intel-card--contract">
                    <div className="intel-card__top">
                      <span className="intel-card__sym">🛡️ {c.symbol}</span>
                      <span className="intel-card__amount">
                        ${(c.amount / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}M
                      </span>
                      <span className="intel-card__date">{c.date}</span>
                    </div>
                    <div className="intel-card__recipient">{c.recipient} · {c.agency}</div>
                    <div className="intel-card__desc">{c.description}</div>
                    <div className="intel-card__award-id">Award ID: {c.awardId}</div>
                  </article>
                ))}
              </section>

              <section className="intel-section">
                <div className="intel-section__head">
                  <span className="intel-section__tag">STOCK WATCHER CAPITOL HILL</span>
                  <h3 className="intel-section__title">Congressional &amp; Senate Trades</h3>
                </div>
                <p className="intel-section__desc">
                  Transactions disclosed under the STOCK Act by members of Armed Services, Intelligence, and Banking committees.
                </p>

                {filteredTrades.map((t) => (
                  <article key={t.id} className="intel-card intel-card--capitol">
                    <div className="intel-card__top">
                      <span className="intel-card__sym">🏛️ {t.symbol}</span>
                      <span className={`intel-card__side is-${t.transactionType.toLowerCase()}`}>
                        {t.transactionType.toUpperCase()}
                      </span>
                      <span className="intel-card__date">{t.date}</span>
                    </div>
                    <div className="intel-card__politician">
                      <strong>{t.politician}</strong> ({t.chamber})
                    </div>
                    <div className="intel-card__committee">Committee: {t.committee}</div>
                    <div className="intel-card__amount-range">Amount: {t.amountRange}</div>
                  </article>
                ))}
              </section>
            </div>
          )}

          {/* TAB 3: FLOW <GO> */}
          {activeTab === 'FLOW' && (
            <div className="intel-tab-pane" data-testid="pane-flow">
              <section className="intel-section">
                <div className="intel-section__head">
                  <span className="intel-section__tag">CBOE &amp; BLACK-SCHOLES ENGINE</span>
                  <h3 className="intel-section__title">Gamma Exposure (GEX) Microstructure</h3>
                </div>
                <p className="intel-section__desc">
                  Net dealer gamma positioning and critical volatility barrier boundaries drawn on the price chart.
                </p>

                {currentGex && (
                  <div className="gex-summary-card">
                    <div className="gex-stat">
                      <span className="gex-stat__lbl">NET GEX</span>
                      <span className={`gex-stat__val ${currentGex.netGex >= 0 ? 'is-pos' : 'is-neg'}`}>
                        {currentGex.netGex >= 0 ? '+' : ''}${(currentGex.netGex / 1_000_000).toFixed(1)}M/pt
                      </span>
                      <span className="gex-stat__sub">
                        {currentGex.netGex >= 0 ? 'Vol Dampening (Dealers Long)' : 'Vol Accelerating (Dealers Short)'}
                      </span>
                    </div>

                    <div className="gex-levels-grid">
                      <div className="gex-level-item is-call">
                        <span className="gex-level-item__name">CALL WALL (CEILING)</span>
                        <span className="gex-level-item__px">${currentGex.callWall.toFixed(2)}</span>
                        <span className="gex-level-item__note">Dealer Short Call Resistance</span>
                      </div>
                      <div className="gex-level-item is-put">
                        <span className="gex-level-item__name">PUT WALL (FLOOR)</span>
                        <span className="gex-level-item__px">${currentGex.putWall.toFixed(2)}</span>
                        <span className="gex-level-item__note">Dealer Long Put Floor / Gamma Ramp</span>
                      </div>
                      <div className="gex-level-item is-flip">
                        <span className="gex-level-item__name">GAMMA FLIP (TRIGGER)</span>
                        <span className="gex-level-item__px">${currentGex.gammaFlip.toFixed(2)}</span>
                        <span className="gex-level-item__note">Vol Regime Inflection Strike</span>
                      </div>
                    </div>
                  </div>
                )}
              </section>

              <section className="intel-section">
                <div className="intel-section__head">
                  <span className="intel-section__tag">FINRA REG SHO &amp; OTC TRANSPARENCY</span>
                  <h3 className="intel-section__title">Dark Pool (Off-Exchange) TRF Volumes</h3>
                </div>
                <p className="intel-section__desc">
                  ATS (Alternative Trading Systems) daily off-exchange volume. Ratios &gt;50% flag institutional accumulation or distribution.
                </p>

                {currentDarkPool && (
                  <div className="darkpool-card">
                    <div className="darkpool-row">
                      <span className="darkpool-lbl">OFF-EXCHANGE SHORT RATIO:</span>
                      <strong className={`darkpool-ratio ${currentDarkPool.shortRatio > 0.5 ? 'is-high' : ''}`}>
                        {(currentDarkPool.shortRatio * 100).toFixed(1)}%
                      </strong>
                    </div>
                    <div className="darkpool-bar">
                      <div
                        className="darkpool-bar__fill"
                        style={{ width: `${Math.min(100, currentDarkPool.shortRatio * 100)}%` }}
                      />
                    </div>
                    <div className="darkpool-details">
                      <div>Total Volume: {currentDarkPool.totalVolume.toLocaleString('en-US')}</div>
                      <div>Off-Exchange Short: {currentDarkPool.shortVolume.toLocaleString('en-US')}</div>
                      <div>OTC Non-ATS: {currentDarkPool.otcVolume.toLocaleString('en-US')}</div>
                    </div>
                    <div className="darkpool-flag">
                      INSTITUTIONAL SIGNAL:{' '}
                      <span className={`darkpool-flag-badge is-${currentDarkPool.institutionalFlag.toLowerCase()}`}>
                        {currentDarkPool.institutionalFlag}
                      </span>
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}

          {/* TAB 4: GEO & EXHAUST <GO> */}
          {activeTab === 'GEO' && (
            <div className="intel-tab-pane" data-testid="pane-geo">
              <section className="intel-section">
                <div className="intel-section__head">
                  <span className="intel-section__tag">OPENSKY NETWORK ADS-B TELEMETRY</span>
                  <h3 className="intel-section__title">Corporate Jet M&amp;A Radar</h3>
                </div>
                <p className="intel-section__desc">
                  FAA ICAO24 transponder tracking. Flights to private executive hubs (Omaha, Zurich, Sun Valley) alert potential M&amp;A or restructuring.
                </p>

                {filteredJets.map((j) => (
                  <article key={j.id} className="intel-card intel-card--jet">
                    <div className="intel-card__top">
                      <span className="intel-card__sym">✈️ {j.symbol}</span>
                      <span className="intel-card__tail">{j.tailNumber} ({j.icao24})</span>
                      <span className="intel-card__date">{j.date}</span>
                    </div>
                    <div className="intel-jet-route">
                      <span>{j.origin}</span>
                      <span className="intel-jet-arrow">──✈──▶</span>
                      <span>{j.destination}</span>
                    </div>
                    {j.isMaHub && (
                      <div className="intel-triggers">
                        <span className="intel-trigger-badge is-alert">
                          🎯 Executive Transit Alert: {j.hubName}
                        </span>
                      </div>
                    )}
                  </article>
                ))}
              </section>

              <section className="intel-section">
                <div className="intel-section__head">
                  <span className="intel-section__tag">GREENHOUSE &amp; LEVER ATS FEED</span>
                  <h3 className="intel-section__title">Talent Velocity &amp; Headcount Velocity</h3>
                </div>
                <p className="intel-section__desc">
                  Weekly differential of open engineering and R&amp;D positions. Identifies covert product cycles or unannounced hiring freezes.
                </p>

                {currentTalent && (
                  <div className="talent-card">
                    <div className="talent-row">
                      <span>OPEN POSITIONS MOMENTUM (&Delta;%):</span>
                      <strong className={`talent-delta ${currentTalent.talentDeltaPct >= 0 ? 'is-pos' : 'is-neg'}`}>
                        {currentTalent.talentDeltaPct >= 0 ? '+' : ''}
                        {currentTalent.talentDeltaPct.toFixed(1)}%
                      </strong>
                    </div>
                    <div className="talent-stats-grid">
                      <div>R&amp;D Openings: <strong>{currentTalent.rdOpenings}</strong></div>
                      <div>Total Listings: <strong>{currentTalent.totalOpenings}</strong></div>
                      <div>
                        Status:{' '}
                        <span className={`talent-badge ${currentTalent.hiringFreeze ? 'is-freeze' : 'is-active'}`}>
                          {currentTalent.hiringFreeze ? 'HIRING FREEZE' : 'EXPANDING'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>

        {/* Macro Liquidity Ticker Footer */}
        <div className="intel-drawer__macro-bar" data-testid="intel-macro-bar">
          <div className="macro-chip">
            <span className="macro-chip__lbl">SOFR</span>
            <span className="macro-chip__val">{macro.sofrRate.toFixed(2)}%</span>
          </div>
          <div className="macro-chip">
            <span className="macro-chip__lbl">HY SPREAD (CDS)</span>
            <span className="macro-chip__val">{macro.hySpreadBps.toFixed(0)} bps</span>
          </div>
          <div className="macro-chip">
            <span className="macro-chip__lbl">10Y-2Y YIELD CURVE</span>
            <span className={`macro-chip__val ${macro.yieldCurve10Y2Y < 0 ? 'is-neg' : 'is-pos'}`}>
              {macro.yieldCurve10Y2Y < 0 ? '' : '+'}
              {macro.yieldCurve10Y2Y.toFixed(2)}% {macro.yieldCurve10Y2Y < 0 ? '(INVERTED)' : ''}
            </span>
          </div>
          <div className={`macro-regime-badge is-${macro.stressRegime.toLowerCase()}`}>
            {macro.stressRegime} CREDIT STRESS
          </div>
        </div>
      </aside>
    </>
  );
}
