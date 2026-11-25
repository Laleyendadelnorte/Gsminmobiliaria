# Backend GCM

TypeScript services run inside the Next.js Node runtime. PostgreSQL is the source of truth for users, memberships, sessions, inventory, CRM, private offers, visits, sandbox finances and audit. The pg pool is exported as `db`, the Drizzle instance as `orm`; transactional SQL is used for locking, relational queries and migrations. No browser receives database credentials, password hashes or provider secrets.

## Installation and bootstrap

1. Configure `DATABASE_URL`, `APP_URL`, `BOOTSTRAP_EMAIL`, a random `BOOTSTRAP_PASSWORD` of at least 12 characters, `WEBHOOK_SECRET` and `SESSION_SECRET` using environment secrets. `SESSION_SECRET` is reserved for signed integrations; opaque sessions use independent 256-bit random secrets and SHA-256 hashes.
2. Run `npm run db:migrate` then `npm run bootstrap`. Migration checksums prevent silent edits to applied migrations; an advisory lock serializes installers. Bootstrap is idempotent and never overwrites existing credentials or promotes an existing non-admin.
3. For explicitly labeled development fixtures only, run `ALLOW_DEMO_SEED=true npm run db:seed`. It creates 15 fictional properties, five fictional prospects (no Alejandro), three offers, 21 future slots and two sandbox visits. Repeated seed calls do not duplicate records. Photos are illustrative, not representations of verified listings. Demo records have `DEMO-*` codes and internal labels.
4. Optional development access: generate a random 32-byte token, store only its SHA-256 hex digest in `BOOTSTRAP_TOKEN_HASH`, and set `ENABLE_BOOTSTRAP_ACCESS=true`. POST the original token to `/api/auth/access`. Never commit the token or a usable invitation. Disable this entry point after onboarding. Normal login uses email and password.
5. All mutation requests except cryptographically authenticated payment webhooks require `Origin` equal to `APP_URL` origin, including login and portal exchange. API examples from curl must include that Origin header.

Admin sessions last 12 hours; cookies are HttpOnly, SameSite=Lax and Secure over HTTPS/production. Portal sessions last at most seven days and never outlive the invite. Sessions and invitations store only random-token hashes. Logout and password change revoke administrative sessions. There is no public admin registration. Automated email recovery and OTP are not configured: password recovery requires the operator procedure below until a delivery provider is integrated.

## Service authorization and transactions

`AuthContext` contains `organizationId`, `userId`, `role` and optional `client: PoolClient`. Services check organization for every resource. ADMIN sees organization resources; AGENT sees own prospects/offers/visits and shared inventory, but can modify only their own inventory. ASSISTANT can read scoped data and cannot mutate. Role and organization come from persisted membership, never request JSON.

`transaction(client => service({...ctx, client}, input))` permits a single atomic AI or application operation. Nested services use the existing client; they do not open a second transaction. Dynamic query filters are parameterized, and dynamic field names are drawn from fixed schemas. `ownerClause` interpolates only a validated UUID from the trusted context.

The route dispatcher is `src/server/router.ts: handle(Request, path[])`. Domain services are in `domain.ts`; authentication is in `auth.ts`; narrow portal authorization is in `portal.ts`; scheduling is in `visits.ts`; `PaymentProvider` and sandbox accounting are in `payments.ts`. Request schemas reject unexpected fields for financial, property and offer writes. Errors return `{error, details?}` without stack traces. Responses containing private content use `Cache-Control: no-store, private` and `X-Robots-Tag: noindex, nofollow`.

## API

All paths below begin `/api/`. JSON lists return `{items,total,page,pageSize}` unless explicitly documented. IDs are UUIDs, dates UTC, money integer minor units, unknown amounts null. No exchange rate is assumed.

| Area | Routes |
|---|---|
| Auth | POST `auth/login`, `auth/access`, `auth/logout`, `auth/password`; GET `auth/session` |
| Inventory | GET/POST `properties`; GET/PATCH/DELETE `properties/:id`; POST `properties/:id/duplicate`; POST `properties/import`; GET `properties/export` |
| CRM | GET/POST `prospects`; GET/PATCH/DELETE `prospects/:id`; POST `prospects/:id/notes`, `prospects/:id/duplicate`; PATCH `prospects/:id/preferences`; GET `prospects/export` |
| Offers | GET/POST `offers`; GET/PATCH `offers/:id`; GET `offers/:id/preview`, `offers/:id/versions`; POST `offers/:id/publish`, `pause`, `revoke`, `regenerate`, `duplicate`, `revert` |
| Portal | POST `portal/session`; GET `portal/:slug`; POST `portal/:slug/favorites`, `interests`, `visits`; GET `portal/:slug/availability`; POST `portal/:slug/payments/:id/sandbox-pay` |
| Scheduling | GET/POST `visits`, `visits/availability`; POST `visits/:id/cancel`, `reschedule`, `check-in`, `complete` |
| Finance | GET `payments`, `payments/:id`, `payments/export`; POST `payments/:id/sandbox-pay`, `refund`, `checkout`, `reconcile`; POST `payments/webhook` |
| Admin | GET `dashboard`, `reports`, `audit`, `settings`, `health`; PATCH `settings` (ADMIN) |
| AI | See `docs/ai.md`; router forwards `ai/*` to the dedicated module. |

Create a property: `{code,title,type,status,priceMinor,currency,...}`. `type` uses Spanish uppercase enum. PATCH only changed fields. DELETE archives instead of destroying financial references. Media URLs may be supplied as gallery entries, but actual upload/MIME validation is handled by the separate media module.

CSV import body `{csv,commit:false}` previews row validation; `{csv,commit:true}` commits all valid rows in one transaction, rejecting the entire import when any row is invalid. Maximum 1,000 rows / 1 MB. Columns use API field names. `amenities` uses pipe-separated values and `priceMinor` must be an integer, e.g. 800000000 for RD$8m. Codes must be unique in the organization. Export escapes spreadsheet formulas. Exports cap at 10,000 records and retain current filters.

Prospect duplication requires `{confirmed:true,name?}`; it copies preferences, not contact information, consent, history, sessions or finances. Contact duplicate candidates are returned for manual review. Name matching removes accents and repeated whitespace; phone matching removes formatting. Country-code interpretation is not inferred.

Create draft: `{prospectId,propertyIds,title?,greeting?,introduction?,theme?,slug?,expiresAt?,idempotencyKey?}`. Existing offer edits accept `expectedVersion` and reject stale revisions. Every content change creates a version, returns to BORRADOR and revokes old access. `publish` and `regenerate` require `{approved:true}`. Publication returns `{offer,url,token}` only once for that call. Invitation token is in a URL fragment to keep it out of ordinary request logs; frontend exchanges it via `portal/session` then removes the fragment. Tokens never appear in list APIs. Publish/regenerate/pause/revoke invalidate previous sessions and invitations. Revert accepts `{version}` and produces a new draft. A duplicated offer always has a new ID and slug.

Portal session body `{slug,token}` creates a cookie specific to that offer. Portal payload returns only public property fields, a prospect first name, contact settings, terms, favorites and visits. It never returns owner name, private address, internal notes, full prospect identity or access tokens. A slug alone is not authorization. Favorites and interactions require membership of the property in the current offer.

## Visits and sandbox accounting

Availability creation: `{startAt,endAt}` (UTC ISO8601), future interval 15–240 minutes by configured UI; backend caps at four hours. Database and advisory locks prevent overlapping agent availability and duplicate active slot reservations. A booking holds the slot for 15 minutes while pending payment; expired holds are released on availability/list/create operations. No independent timer is needed for correctness because every booking performs expiration under transaction before checking occupancy.

Visit creation: `{offerId,propertyId,slotId,termsAccepted:true,termsVersion}`. Portal supplies only the latter four fields, deriving offer/agent/prospect from the authenticated invitation. The server locks the offer, property and slot, checks current availability and terms, and snapshots price, deposit, currency and terms. Unknown financial fields such as `depositMinor` are rejected. The result is `{visit,payment,checkout}`; checkout explicitly says sandbox and has no real payment URL.

`check-in` accepts `{attended:true}` (default) or false. Attendance on a confirmed visit creates REEMBOLSO_PENDIENTE. It does not mark money returned. `refund` requires a human API action and accepts `{idempotencyKey?,amountMinor?,evidence?}`. The sandbox adapter confirms only its local simulated transaction; the UI must label it accordingly. Transactional row locks plus unique idempotency keys prevent duplicate and excessive refunds. The immutable ledger stores DEPOSIT and REFUND entries; update/delete triggers reject ledger mutation. No real card or bank processing is implemented.

Agent cancellation preserves payment history and proposes full refund via pending status. Rescheduling changes the slot while retaining visit ID, deposit and history. No inattendance confiscation or fee policy is invented. Terms and amount are frozen at booking. Initial DOP guarantee is 50,000 minor units (RD$500). Settings changes apply to newly created offer policies; existing offer/reservation policies preserve their recorded amounts.

Webhook header `X-GCM-Signature: t=<unix-seconds>,v1=<hex HMAC-SHA256>` signs `<t>.<exact raw body>` with `WEBHOOK_SECRET`. Timestamp tolerance is five minutes. Payload: `{eventId,type:"payment.paid"|"payment.failed",reference,amountMinor,currency,mode:"sandbox"}`. Signature, event uniqueness, amount, currency, reference, mode and current booking state are checked. Repeated identical events succeed without repeated ledger entries; reused event IDs with different content fail. Future real adapters must handle late capture, external status reconciliation, provider timeout and durable retries before real mode is enabled.

Reports keep currencies separate, report refundable liabilities, and never count guarantees as property revenue. Receipts/references are non-fiscal sandbox records. Reminder jobs are persisted as BLOCKED_NO_PROVIDER and refund review jobs as AWAITING_APPROVAL; no messages are sent without a configured integration and consent.

## Validation

Run unit tests with `npm test`. Integration tests deliberately require a separate database URL ending in `gcm_test` and `RUN_BACKEND_INTEGRATION=true`. Provision it, apply migrations to that database, then run:

```sh
DATABASE_URL=postgresql://.../gcm_test npm run db:migrate
DATABASE_URL=postgresql://.../gcm_test RUN_BACKEND_INTEGRATION=true npx tsx --test tests/backend.test.ts
```

The integration suite creates isolated organizations; do not point it at production. It validates login/CSRF/role permissions, organization and portal isolation, CRUD/import, normalized prospect matching, idempotency, zero/partial matches, slug collisions, version conflicts, raw signed webhook verification, concurrent slot reservation, caller-supplied amount rejection, attendance, concurrent refunds, immutable ledger, cancellation/rescheduling, withdrawal/revocation/expiry, independent connection persistence and rollback of nested services. Independent connection persistence is not a claim of process restart or backup restoration; those require deployment-level tests.

## Boundaries and production work

Live payments are always disabled; the adapter implements only sandbox behavior. A configured value `PAYMENT_MODE=live` does not enable charging. No wildcard domain, OTP, automated password email, calendar sync, S3/private documents, reminder delivery or production refund worker is silently assumed. These need provider credentials and deployment work. Bulk operations, task UI, full property-document workflow, commission model, retention/anonymization automation and robust 10k-load benchmarking remain partial or unimplemented. Application-level tenant filtering is present; PostgreSQL RLS is not enabled. Backups/restoration and transport security must be validated by deployment operations.

Operator password reset: use a privileged maintenance script to set a new bcrypt hash for the verified account and delete all sessions for that user in the same transaction; do not email plaintext credentials or run commands that print secrets. The optional `password_reset_tokens` table is reserved for future configured email delivery. Session/admin tokens are never recoverable from the database.

## Recorded backend validation — 2026-11-25

Executed on the allocated Linux development machine with Node 24, the installed project dependencies, an isolated source snapshot `/tmp/gcm-backend-check-ccSFjy`, and a disposable PostgreSQL database `gcm_backend_gcm_test`. The application database was not used for these tests.

- `tsx scripts/migrate.ts`: applied `001_core.sql` and the media owner's `003_media_storage.sql`; subsequent checksum validation succeeded.
- `tsc --noEmit --strict --skipLibCheck --esModuleInterop --target ES2022 --module esnext --moduleResolution bundler src/server/*.ts scripts/*.ts tests/backend.test.ts`: exit 0.
- `tsx --test tests/backend.test.ts` with integration enabled: 19 passed, 0 failed, 0 skipped. Includes 5 unit tests, 13 integration subtests and their parent test. Final run duration about 3.9 seconds in this environment; this is not a load benchmark.
- `seed()` executed twice against a separate demo organization: exactly 15 properties, 5 prospects, 3 offers, 2 visits, 21 slots and zero prospects named Alejandro afterward.

The first integration run caught a Zod 4 partial-schema default issue that reset omitted fields during PATCH. Both property and prospect updates now preserve omitted values, and regression assertions verify price, status, bedrooms, consent and contact data. The final run also verifies cross-agent property interval conflicts, gallery metadata preservation, rejection of foreign media IDs, full prospect-detail authorization and expired-offer filtering. Formatting was applied to backend-owned TypeScript files only after successful verification. Whole-app build, browser accessibility/responsiveness, actual process restart and backup restoration belong to the integrated application validation; they are not claimed by these backend results.

## Validación posterior del listado de ofertas

El 25-11-2026 se eliminó el patrón N+1 de `listOffers`: conteo + página con prospectos + selección por lote + medios por lote. Son cuatro consultas totales (tres después del conteo), tanto para 1 como para 100 ofertas. La regresión compara la respuesta completa con `getOffer`, verifica orden, paginación, galerías compartidas, selecciones vacías y aislamiento. Backend final: 20/20 pruebas, cero fallos/omisiones. Integración global posterior: 48/48 incluidas IA y medios.
