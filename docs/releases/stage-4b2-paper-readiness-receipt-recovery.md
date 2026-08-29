# Stage 4B2 authoritative receipt recovery

The Stage 4B2 receipt was recovered byte-for-byte after its GitHub Actions artifact expired. This recovery did **not** establish a new trust root. The recovered bytes reproduce the authority already pinned by the existing Stage 4B3 verifier.

- Historical source commit: `81b0980f4fee168075a52c6ebcb12eb50f382217`
- Historical workflow run: `30320628525`
- Historical job: `90155555227`
- Expired artifact: `stage-4b2-receipt-81b0980f4fee168075a52c6ebcb12eb50f382217`
- Recovered `generatedAt`: `2026-07-28T01:37:40.000Z`
- Receipt ID: `64b15a8acef9b1ba6f16ff87f81d27fcf28fbf6b94424d059521a20702165785`
- Raw SHA256: `5fefa5c1ddb025c94300e8b7dcb3b6d9dd5ba2e36a6d70e2ec10554d1d6a2453`
- Byte length: `952`
- Stage 4B1 raw SHA256: `4d474f9d357fa6fb7d584576a891c5916f4f7ca4166d82027dba8fb29947d4aa`

The bounded recovery search covered `2026-07-28T01:35:00.000Z` through `2026-07-28T01:39:00.000Z`, inclusive. Of 241 candidates, the unique match was `2026-07-28T01:37:40.000Z`. Negative controls rejected T-1 second, T+1 second, and a one-byte mutation.

The ad-hoc forensic recovery harness was not a project test suite.
