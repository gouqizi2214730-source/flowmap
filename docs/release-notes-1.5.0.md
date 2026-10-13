# FlowMap 1.5.0

This release improves recorded liquidity-history inspection, the orderflow
workspace, and integration with supported public L2 sources.

- **Recorded depth history:** Actual recordings beyond the live-memory window
  load from disk. Wide time views aggregate recorded quantities; zooming in
  returns to the original detail. Price-range changes preserve physical prices,
  and unrecorded ranges stay empty. The first large history load reads disk
  progressively; readiness depends on recording size and the computer.
- **Workspace:** Orderflow, Analysis, and Focus layouts, resizable DOM/tape/CVD
  panels, remembered instrument selection, and 15s/1m/5m/30m/All time-window
  controls are included.
- **Received-data readouts:** Bid/ask prices and inside quantities, spread, and
  the age of the last received quote are shown. The trade-flow panel calculates
  5/30/60-second buy, sell, and delta quantities from received trades. Missing
  trade direction or depth is shown as unavailable.
- **Chart and liquidity:** Tolerance and normalization follow visible
  liquidity. History, the price axis, and chart layers use coordinated geometry;
  DOM grouping is separate from quote/tape price precision.
- **Public L2 integration:** The vendored Crocodile engine uses supported public
  connections. It forwards the source's actual depth mode and book-update
  counters. Update cadence depends on the venue and selected connection.
- **Intelligence panels:** The previously unpublished FLOW, GOV, DOCS, GEO, and
  MACRO views are included. Demo content is restricted to SIM-DEMO. When a
  source supplies no data, the panels do not generate sample figures or events.
  GEX is labeled as a model and displayed in millions of dollars per 100%
  relative spot move. Its fixed call-positive/put-negative assumption does not
  establish dealer inventory. Gamma flip is calculated only when a sign
  crossing exists; missing observed option-chain data is shown as unavailable.
  Text is not used to infer voice measurements, and SEC text without a risk
  section is not turned into a risk warning.
- **Fixes:** Switching instruments clears the previous profile. On slow
  displays, a rendered chart no longer remains hidden beneath the loading
  screen. `I` opens the indicator selector and `J` opens the research panel.
  While viewing history, live price recentering keeps the selected time window
  intact, and forward navigation can reach newly received history.
  A slow initial subscription sends its handshake before keepalive pings.
  Trade thresholds use source quantities; differing contract units are not
  presented as USD.
- **Desktop packaging:** The Windows server process runs without a console
  window and terminates when the app closes. App, client, and server versions
  are aligned at 1.5.0. Packaging uses locked dependencies and the vendored
  engine. Intel macOS packages include OpenSSL and do not require Homebrew on
  the user's Mac. macOS 11 is no longer supported. Each macOS package declares
  the minimum system version required by its bundled native libraries.

The release workflow builds macOS Apple Silicon/Intel DMGs, Windows x64/ARM64
MSI and NSIS installers, and Linux x64 DEB packages. Linux AppImage is attempted
as an optional additional package. `SHA256SUMS` accompanies the release assets,
and build-provenance attestations are available for the installers.
