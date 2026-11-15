# S1, S2 and S6 review

The required read-only `gpt-6.1-sol` review ran at high effort on 2026-11-14. It examined the simulator, demo/autofill routes and tests, and reproduced edge cases. The CLI exhausted its usage allowance before writing a verdict (exit 1 after 124,919 tokens). Review skipped: no final reviewer verdict was available. No second review was run, following the root review gate.

The lead checked the reproduced issues and made one fix pass:

- Exact mass conversions now support prices per kilogram with yields per tonne; bushel conversions still require compatible units.
- An entered 0% weather-loss assumption retains its assumption metadata.
- Profit badges, money deltas and profit ranking exclude comparisons across different currencies.
- Seasons beyond a requested short horizon no longer affect the replay pool or crop-family indicators.
- Sourced harvested-area yields and planted-area costs cannot produce a margin without compatible inputs.
- Replay accepts validated field readings and returns them beside modeled values without changing the NASA series. Farm analysis accepts equipment/readings and forwards equipment to generation.

Regression tests cover these changes. S6 tests cover both synthetic demo farms, NC-only rule applicability, missing calendars, chronology, and per-date sources. The final release gates are the full pytest suite, ruff, contract freshness, and both live browser demo flows.
