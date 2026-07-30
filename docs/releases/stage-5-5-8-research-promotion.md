# Stage 5.5-5.8 — Train/Validation Research and Promotion Decision

The single frozen research round evaluated all four registered strategies and all twelve predeclared parameter sets. Each combination was evaluated across BNB, BTC, ETH, and SOL using three chronological 5m TRAIN folds, three chronological VALIDATION folds, and the frozen high-cost VALIDATION model. Consecutive folds have an explicit 96-bar embargo; inputs begin after the 100-bar warm-up and end before the 96-bar phase tail.

All candidate/parameter results are reported. Cross-asset gate aggregation is conservative: median asset net return, worst asset drawdown, and minimum asset profit factor, Sharpe, and Sortino. No market, time range, parameter result, or failed candidate is omitted. Volatility-tercile labels are descriptive only and do not affect selection. The comparison count remains the frozen twelve; there is no candidate expansion or second research round.

No parameter combination passed the frozen validation thresholds. Even each candidate's best rejected parameter had negative TRAIN and VALIDATION median net return, excessive drawdown, negative risk-adjusted metrics, profit factor below one, and worse high-cost performance. This is a valid research outcome, not an infrastructure failure.

Because Stage 5.5 froze no candidate, Stage 5.6 is `SKIPPED_BY_CONTRACT_NO_FROZEN_CANDIDATE`: locked-test access remains zero and no test rows, hashes, or results exist. Stage 5.7 records `NOT_RUN_NO_VALIDATED_CANDIDATE` and `OVERFIT_RISK=HIGH`; Stage 5.8 leaves every candidate in `REJECTED_VALIDATION` and emits `NO_PROMOTED_STRATEGY`.

The evidence is offline research only. It contains no private OHLCV rows or local paths. It is not a Paper fill, exchange fill, order, activation authorization, or approval for Paper, Testnet, or Live.
