# FlowMap 1.5.1

Replay now lets you choose a recorded window for the current instrument. The picker shows recorded hours, UTC date/time editing with local readouts, short-window presets and the exact available bounds before confirmation. Recorded selections, defaults and presets retain their absolute instants through repeated local hours. The current stream keeps running until you open the selection paused. Empty or oversized selections show an error; listed hours can contain gaps.

Recorded prices, density and stored bars keep their original positions and times. Seeking works while paused, including the first and final columns, and clears frames from the previous position. The final column remains visible with an ENDED state. Reconnecting preserves the current position and playback state; explicitly reopening a selection starts it paused at the beginning.

Replay is labeled RECORDED DENSITY. Quotes are reconstructed from occupied row centers; original raw L2 is unavailable in these recordings. When a column cannot supply valid bid and ask quotes, the DOM and chart keep its density visible and clear quote and spread readouts. Recorded gaps remain empty.

Returning to LIVE restores your time and price follow preferences, including a change made immediately before opening replay.

Yahoo resets and intraday conversion run in background workers. Equity preloading admits at most four quote workers. Its cutoff prevents new work and rejects late results; cleanup can take longer while a blocking Yahoo call finishes.

Crypto certificate loading and fallback market setup also run in workers, with at most four quote workers admitted during preloading. This keeps that setup work off the live server loop; cancellation waits for owned workers to finish cleanup.

Server log output and first-time Yahoo loading run in workers too. Slow log writes no longer run on the live server loop. If the bounded log buffer fills, dropped diagnostics are counted and reported once output resumes.

The timeline thumb now follows chart movement directly. Its labels keep their slower refresh. At the newest recorded point, the chart waits for actual incoming data; it does not create market updates to fill a gap.

Windows measurements on this PC passed graphics gates in a 10-minute LIVE trial and a 30-minute history test. History retains its original PASS output; retrospective assessment is INCOMPLETE because the final loss/recorder end tail was not observed. Its graphics/input/resource measurements remain usable. Overall qualification remains NOTQUALIFIED; LIVE source debt failed and no complete matched sustained campaign exists. The [benchmark report](windows-minimum-benchmark.md) preserves original outcomes and hashes; CPU limits describe this Ryzen and RAM is a planning estimate from 32 GiB hardware.

The measured private build08 predates the picker correction and corrected external health harness. The original traces used the earlier harness. Corrected release source has not undergone new native performance, campaign, installer or pixel validation.

Stable publication waits for all eight platform installers and their checksum manifest.

Testing: saved-drawing checks explicitly frame persisted anchors. Functional full-ring history waits allow 150 seconds on software-rendered CI. The 360-second outer test and complete correctness and pixel checks remain; this is a longer wait allowance, not a loading speed improvement. CI retains test results and traces.
