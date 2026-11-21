# Staging provenance correction

`original/apps/server/src/ws.test.ts` is restored from the independent combined actual source snapshot at `C:\Users\maximilian\Desktop\EDITING\highlight editing pipeline app\git\t3-code-hooks\backups\combined-actual-source-nonsecurity-20261103\original\apps\server\src\ws.test.ts`.

The restored file SHA-256 is `C245DA73B43C01AC74E3ADD986CAA607B6FB25065A1C7F6B66E281855EE2FB31`, matching the independently supplied hash. The independent snapshot's `integration-manifest.json` does not list `apps/server/src/ws.test.ts`; therefore this note records the byte-for-byte hash match, not a per-file manifest assertion.

The staged post-edit copy that was temporarily placed in `original/` is preserved at `recovery/apps/server/src/ws.test.postedit-copy.ts` with SHA-256 `B6916D5AD2E11BA9198D2F85AFDFFF75B5995B55CF5CB62C5039BFCDF6B86C25`. The candidate remains at `new/apps/server/src/ws.test.ts`. Neither preserved copy should be overwritten.

Rollback status: the original snapshot now matches the independent pre-edit baseline. The live source still contains the newly added WebSocket RPC test; its focused test run is not passing yet because the test fixture lacks a `ScratchThreadPromotion` service. No install or restart was performed.

## 3 Nov 2026 15:47 CET correction

The earlier post-edit hash B691... was the source baseline before the RPC fixture repair. The validated staged RPC test is now integrated and source/new match at SHA-256 EF7B4FCB4E28FBB17E836DC2C88D1DA7FC90489FCB721B6BAD0C619452B50809. The focused staged and source RPC tests pass; the source typecheck passes. The original C245... snapshot and preserved B691... recovery copy remain unchanged. See integrated-hashes-20261103-1547.csv for refreshed integrated path hashes. No install or active-app restart was performed.
