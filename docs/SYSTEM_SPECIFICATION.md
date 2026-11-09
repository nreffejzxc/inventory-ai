# Inventory AI — System Specification

**Version:** 1.0 (this specification) · the tree is **1.0.2**; the shipped production binary is **1.0.1** · **Status:** implemented for
V1 — every behaviour below is live or marked as a non-goal · **Platforms:** Android + iOS (iOS is
unverified: no macOS host) · **Architecture:** React Native + Expo + Node.js + Express + MongoDB Atlas

> This is the **authoritative statement of required behaviour**. Where the shipped code differs, that
> is a defect or a recorded change — `docs/DEVELOPMENT_ROADMAP.md` holds the dated record for each
> change, and `docs/AUTHENTICATION_AND_USER_VERIFICATION_TARGET_ARCHITECTURE.md` describes the auth
> layer as it actually runs. Do not edit a rule here to match the code without the owner's approval.

---

# 1. Project Overview

Inventory AI is a cross-platform mobile Inventory Management System designed for small and medium-sized businesses.

The application allows authorized users to:

- Manage products
- Manage categories
- Manage locations
- Track inventory
- Record stock-in transactions
- Record stock-out transactions
- View inventory history
- Monitor low-stock and out-of-stock products
- View inventory summaries
- Search and filter products
- Ask an AI assistant questions about inventory data

The AI assistant is an additional interface for interacting with authorized inventory information. It must not replace the application's core inventory functionality.

The inventory system must remain usable even when the AI service is unavailable.

---

# 2. Product Goals

## Primary Goals

1. Provide a simple mobile inventory management experience.
2. Maintain accurate inventory quantities.
3. Maintain an auditable history of inventory changes.
4. Secure business and user data.
5. Support multiple users with different permissions.
6. Provide an AI assistant capable of answering inventory-related questions.
7. Build the architecture so future features can be added without major rewrites.
8. Support Android and iOS from the same mobile codebase.

## Non-Goals for V1

The following features are intentionally excluded from V1:

- Online payments
- Subscription billing
- Full offline synchronization
- AI-powered stock modification
- AI forecasting
- Demand prediction
- Advanced supplier management
- Complex accounting
- Advanced reporting
- RAG / vector search
- Automated purchasing
- Multi-business SaaS billing
- Advanced barcode/QR scanning

These may be considered in future versions.

---

# 3. Technology Stack

## Mobile

- React Native 0.88 · Expo SDK 58 · Expo Router
- TypeScript
- REST API communication
- Secure local token storage

## Backend

- Node.js
- Express.js
- TypeScript
- REST API
- JWT authentication
- bcrypt password hashing

## Database

- MongoDB Atlas
- Mongoose

## AI

The application must use an AI provider abstraction.

Providers:

- **OpenRouter** — an Anthropic-compatible gateway, and the **only shipped provider** (owner decision,
  **AI-25**, 2026-10-19). It speaks the Anthropic Messages wire through one shared mapping layer, so it
  is a configuration over that layer rather than a second protocol implementation. Because it fronts
  many models with differing tool-calling ability, `AI_MODEL_OPENROUTER` is required and has no default.
- Anthropic Claude and Google Gemini are reachable **through that gateway as model choices** — changing
  `AI_MODEL_OPENROUTER` is the whole change. Their direct provider implementations were **removed** in
  AI-25: both needed their own API key, model variable and billing to be usable, and neither was
  exercised in production. The provider **interface** and the shared wire layer remain, so restoring a
  direct provider is one small factory plus one registry entry.
- The retired AgentRouter gateway is **not** a provider: it was removed and must not be reintroduced.

The application must not tightly couple the business logic to one AI provider.

Example conceptual architecture:

```text
AI Service
├── Provider Interface
└── OpenRouter Provider  (Claude/Gemini models are chosen here via AI_MODEL_OPENROUTER)
```

The active provider should be configurable through server-side environment variables.

---

# 4. High-Level Architecture

```text
┌───────────────────────────────┐
│       React Native App        │
│        Expo + Expo Router     │
└───────────────┬───────────────┘
                │
                │ HTTPS / REST API
                ▼
┌───────────────────────────────┐
│       Node.js + Express       │
│                               │
│ Authentication               │
│ Authorization                │
│ Business Logic               │
│ Validation                   │
│ Inventory Logic              │
│ Audit Logging                │
│ AI Service                   │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│         MongoDB Atlas         │
│                               │
│ Businesses                   │
│ Users                        │
│ Products                     │
│ Categories                   │
│ Locations                    │
│ Inventory                    │
│ Transactions                 │
│ Audit Logs                   │
│ AI Conversations             │
└───────────────────────────────┘
```

AI requests:

```text
Mobile
  ↓
Backend
  ↓
AI Service
  ↓
AI Provider
  ↓
Controlled Tool
  ↓
Authorization
  ↓
MongoDB
  ↓
Tool Result
  ↓
AI Response
  ↓
Mobile
```

---

# 5. Critical Architecture Rules

These rules are mandatory.

## Rule 1 — Mobile must never access MongoDB directly

The mobile application communicates only with the backend API.

```text
Mobile → API → Database
```

Never:

```text
Mobile → MongoDB
```

## Rule 2 — AI must never access MongoDB directly

The AI provider must never receive database credentials or unrestricted database access.

Never:

```text
AI → MongoDB
```

Instead:

```text
AI → Controlled Backend Tool → MongoDB
```

## Rule 3 — Backend is the security boundary

The backend is responsible for:

- Authentication
- Authorization
- Business isolation
- Input validation
- Inventory rules
- Database operations
- AI tool authorization

## Rule 4 — MongoDB is the source of truth

The AI model must not invent inventory values.

Database-derived information must come from backend tools.

## Rule 5 — AI inherits user permissions

The AI must operate using the authenticated user's identity and permissions.

A STAFF user must not gain ADMIN capabilities simply by asking the AI.

## Rule 6 — Never trust client-supplied businessId

The business associated with a request must be determined from the authenticated user's server-side identity and authorization context.

## Rule 7 — V1 AI is read-only

The AI may:

- Search
- Retrieve
- Summarize
- Explain
- Analyze available inventory information

The AI may not:

- Create products
- Update products
- Delete products
- Modify inventory
- Create stock transactions
- Change users
- Change roles

AI write actions may be considered in a future version with explicit confirmation and additional safeguards.

---

# 6. Multi-Tenant Architecture

The application should be designed as multi-tenant from the beginning.

A business represents one organization using the system.

Conceptually:

```text
Business A
├── Users
├── Locations
├── Products
├── Categories
├── Inventory
└── Transactions

Business B
├── Users
├── Locations
├── Products
├── Categories
├── Inventory
└── Transactions
```

Data from one business must never be accessible to another business.

Every business-owned resource must contain or be resolvable to the appropriate `businessId`.

The backend must enforce this isolation.

---

# 7. User Roles

V1 supports the following roles.

## OWNER

Full business access.

Capabilities:

- Manage business
- Manage users
- Manage roles
- Manage locations
- Manage categories
- Manage products
- Manage inventory
- View transactions
- View dashboard
- Use AI assistant

## ADMIN

Administrative access excluding ownership-level controls.

Capabilities:

- Manage users (create/assign MANAGER or STAFF, enable/disable; never ADMIN or OWNER)
- Manage products
- Manage categories
- Manage locations
- Manage inventory
- View transactions
- View dashboard
- Use AI assistant

User management is strictly business-scoped and server-enforced: no user can
create or assign the OWNER role, no user can change their own role/status, and
an ADMIN can neither create, assign, nor modify another ADMIN. Disabling a user
revokes their access immediately.

## MANAGER

Operational management access.

Capabilities:

- Manage products
- Manage inventory
- View dashboard
- View transactions
- Use AI assistant

## STAFF

Operational staff access.

Capabilities:

- View products
- View inventory
- Perform permitted stock-in
- Perform permitted stock-out
- View permitted inventory history
- Ask AI questions about permitted inventory information

Authorization must always be enforced server-side.

---

# 8. Core Database Collections

V1 should contain the following primary collections:

```text
businesses
users
locations
categories
products
inventory
inventory_transactions
audit_logs
ai_conversations
ai_messages
```

---

# 9. Business Model

Conceptual fields:

```text
Business
├── _id
├── name
├── status
├── planCode
├── createdAt
└── updatedAt
```

Possible statuses:

```text
ACTIVE
SUSPENDED
ARCHIVED
```

Business ownership and user membership must be enforced by the backend.

## Subscription Ownership Is Business-Level

Subscription and billing state belongs to the **business (tenant)**, never to an individual Firebase
identity or user account. Conceptually:

```text
Business
 ├── Owner
 ├── Admin(s)
 ├── Manager(s)
 └── Staff
       ↓
   Subscription / Billing
       ↓
   Business feature access
```

A Firebase UID **must never be used as the subscription owner**. Changing the Owner of a business, or
changing which authentication provider a person signs in with, must not inherently transfer, destroy
or recreate the business's subscription or its feature access.

Entitlements are resolved from the business, not from the person: `planCode` lives on the `Business`
document, the plan catalogue is `server/src/constants/plans.ts`, and the entitlement check is
`server/src/services/entitlement.service.js`. Section 30 governs who may act inside the business.

Subscription plans, billing and paid-plan enforcement are **not implemented** — they are deferred to
V4 (see the retired-sections note below). The foundation above exists so that billing can be added to the tenant without
re-keying ownership onto an identity.

---

# 10. User Model

Conceptual fields:

```text
User
├── _id
├── businessId
├── name
├── email
├── passwordHash        optional
├── firebaseUid         optional
├── emailVerified
├── role
├── status
├── passwordChangedAt
├── createdAt
└── updatedAt
```

Possible statuses:

```text
ACTIVE
DISABLED
```

Passwords must never be stored in plain text.

## Identity Linkage vs. Authorization

`firebaseUid` is an **identity linkage field, not an authorization source**. It records which Firebase
identity a user account is bound to. It never grants a role, a permission, a business, or access to
anything — `businessId`, `role`, `status` and permissions always come from this document, loaded from
the database on every request (§30).

| Field | Notes |
| --- | --- |
| `email` | Globally unique. **Not an account-linking join key** — see §29. |
| `passwordHash` | **Optional.** Absent for an account created through Firebase, which never receives a password through the API. Never returned by any endpoint. |
| `firebaseUid` | Optional, and **sparse-unique**: at most one account per Firebase identity, while any number of accounts may have none. Sparse is mandatory — without it the index cannot be built once two accounts lack the field. |
| `emailVerified` | Persisted from the verified Firebase token claim. **Enforced** at the Firebase register/exchange/renew boundaries — an unverified identity is refused `400 EMAIL_NOT_VERIFIED` — while `requireAuth` itself deliberately reads no `emailVerified`. The verification **mechanism** is being superseded by AUTH-04 (a custom 6-digit Inventory AI code); see §29. |
| `passwordChangedAt` | The revocation clock for §29's `SESSION_INVALIDATED`. |

An account may hold both a retained `passwordHash` and a `firebaseUid`. Where it does, **Firebase is
the authentication authority and the retained hash is not a second way in** (§29, Password Authority).

Every business-owned resource is isolated by `businessId`, and a client-supplied `businessId` is never
trusted (§30).

---

# 11. Location Model

A location represents a warehouse, store, branch, storage area, or other inventory location.

Conceptual fields:

```text
Location
├── _id
├── businessId
├── name
├── description
├── status
├── createdAt
└── updatedAt
```

Possible statuses:

```text
ACTIVE
ARCHIVED
```

V1 may support multiple locations even if the first user only uses one.

---

# 12. Category Model

Conceptual fields:

```text
Category
├── _id
├── businessId
├── name
├── description
├── status
├── createdAt
└── updatedAt
```

Categories must be isolated by business.

---

# 13. Product Model

Conceptual fields:

```text
Product
├── _id
├── businessId
├── name
├── sku
├── barcode
├── description
├── categoryId
├── costPrice
├── sellingPrice
├── unit
├── minimumStock
├── imageUrl
├── status
├── createdAt
└── updatedAt
```

Possible status:

```text
ACTIVE
ARCHIVED
```

## Product Rules

- SKU should be unique within a business.
- Barcode should be unique within a business when provided.
- Archived products should not be treated as active products.
- Product images should be stored externally.
- MongoDB should store image URLs rather than large image files.
- Prices must use appropriate numeric handling.
- `minimumStock` determines the low-stock threshold.

## Product Lifecycle

A product is created `ACTIVE` and moves only between `ACTIVE` and `ARCHIVED`:

```text
ACTIVE  <->  ARCHIVED
```

`ARCHIVED` is the terminal lifecycle state. **Deletion of a product is prohibited by
the application architecture.** No delete, purge, cascade-delete, or soft-delete
operation exists, and none is part of the API contract. Archiving is the supported
way to retire a product, and it is reversible through restore.

A product's `businessId` is not writable after creation, so a product can never be
moved out of the business that owns its inventory.

---

# 14. Inventory Model

Inventory represents the quantity of a product at a specific location.

Inventory must NOT be treated as one global quantity when multiple locations exist.

Conceptually:

```text
Inventory
├── _id
├── businessId
├── productId
├── locationId
├── quantity
├── reservedQuantity
├── availableQuantity
└── updatedAt
```

Relationship:

```text
Product + Location = Inventory Record
```

Example:

```text
Product: Coca-Cola
Location: Main Store
Quantity: 50
```

and:

```text
Product: Coca-Cola
Location: Warehouse
Quantity: 100
```

These are separate inventory records.

## Inventory and Product Integrity

An inventory record is conceptually dependent on its product: a quantity only has
meaning as "this product, at this location".

Archiving a product does not affect its inventory. The inventory records and the
full transaction history of an archived product are retained unchanged, and archived
stock continues to be counted in business-wide quantity totals. Archived products
cannot be used in new stock movements.

Referential integrity between inventory and products is maintained by **application
lifecycle rules and write-path validation** — a movement requires that the product
exists in the authenticated business and is not archived — and **not** by any
database-level foreign key. MongoDB has no cross-collection foreign keys, and
Mongoose `ref` only enables `populate()`; it constrains nothing.

Read-path filters that skip inventory rows whose product cannot be resolved are
defensive query hygiene. They are **not** the mechanism that enforces referential
integrity, and they must not be described or relied upon as such.

## Quantity Rules

```text
availableQuantity =
quantity - reservedQuantity
```

V1 may keep `reservedQuantity` at zero while preserving the architecture for future reservation functionality.

Negative inventory is not allowed by default.

---

# 15. Inventory Transactions

Inventory changes must be represented as transactions.

Transaction history is permanent. It is retained when a product is archived, and it
continues to reference that product by `productId`. Records are not rewritten or
removed when a product's status changes.

Supported V1 transaction types:

```text
STOCK_IN
STOCK_OUT
ADJUSTMENT
TRANSFER
```

Conceptual fields:

```text
InventoryTransaction
├── _id
├── businessId
├── productId
├── locationId
├── type
├── quantity
├── previousQuantity
├── newQuantity
├── reason
├── reference
├── userId
└── createdAt
```

## Stock-In

Example:

```text
Previous: 50
Stock In: +20
New: 70
```

## Stock-Out

Example:

```text
Previous: 70
Stock Out: -10
New: 60
```

## Stock-Out Validation

The backend must reject:

```text
requested quantity > available quantity
```

The system must never silently create negative inventory.

## Stock Transfer

A transfer moves quantity of one product from one location to another location
within the same business. It is a single logical operation that produces two
movement rows.

Example:

```text
Main Warehouse: 50 → 40   (TRANSFER, -10)
Store Front:     5 → 15   (TRANSFER, +10)
```

A transfer is subject to the same rules as any other stock movement:

```text
source and destination must be different locations
quantity must be a positive integer
requested quantity <= available quantity at the source
both locations and the product must belong to the authenticated business
```

A transfer is neither a gain nor a loss — total business inventory is unchanged.
Both legs share one `reference` so the pair can be correlated.

If either leg fails, the operation is compensated so that stock is never lost or
duplicated, the source never goes negative, and a partially applied transfer is
not left behind.

Transfer is a stock movement, not a new permission: it is gated by the existing
`INVENTORY_MANAGE` capability (OWNER, ADMIN, MANAGER).

---

# 16. Inventory Consistency

Inventory quantity updates and transaction creation must be handled safely.

The implementation must avoid situations where:

```text
Inventory updated
BUT
Transaction failed
```

or:

```text
Transaction created
BUT
Inventory update failed
```

Where supported and appropriate, database transactions should be used to preserve consistency.

Concurrent inventory updates must also be considered.

---

# 17. Audit Logs

Important system operations should generate audit logs.

Examples:

```text
PRODUCT_CREATED
PRODUCT_UPDATED
PRODUCT_ARCHIVED

INVENTORY_STOCK_IN
INVENTORY_STOCK_OUT
INVENTORY_ADJUSTED

USER_CREATED
USER_ROLE_CHANGED
USER_DISABLED
```

Conceptual fields:

```text
AuditLog
├── _id
├── businessId
├── userId
├── action
├── entityType
├── entityId
├── metadata
└── createdAt
```

Audit logs should provide enough information to understand:

- Who performed the action
- What was changed
- Which entity was affected
- When it happened

---

# 18. Search

Product search must support:

- Product name
- SKU
- Barcode

Filters:

- Category
- Location
- Active/Archived
- Low stock
- Out of stock

Search results must support pagination.

Search should be optimized using appropriate MongoDB indexes.

---

# 19. Low Stock Logic

A product is considered low stock when:

```text
availableQuantity <= minimumStock
```

Out-of-stock:

```text
availableQuantity <= 0
```

The exact implementation must account for the selected location.

Dashboard statistics must use consistent definitions.

---

# 20. Dashboard

V1 dashboard should provide:

- Total products
- Total inventory quantity
- Low-stock products
- Out-of-stock products
- Recent inventory activity

Future dashboard features may include:

- Sales analytics
- Purchase analytics
- Inventory valuation
- Trends
- Charts
- AI-generated reports

---

# 21. AI Assistant

The AI assistant is a natural-language interface for authorized inventory information.

Example questions:

```text
"What products are low in stock?"

"How many Coca-Cola items do we have?"

"Which products are out of stock?"

"Show me inventory in the warehouse."

"What was the recent stock activity?"

"Which products have the highest quantity?"
```

The AI must answer using controlled backend tools.

---

# 22. AI Tool Architecture

Current read-only tools:

```text
searchProducts
findProducts
getProduct
getInventory
getLowStockProducts
getOutOfStockProducts
getProductsNeverSold
getReorderNeededProducts
getStockValue
getCatalogOverview
getInventorySummary
getLocationBreakdown
getInventoryHistory
getProductsByLocation
listLocations
listCategories
listBrands
researchInventoryProducts
researchMarketPrices
```

The list above is the current set as implemented, and no tool writes. `findProducts` adds exact
identity lookup by name, SKU or barcode (AI-91); `getStockValue` groups value by recorded currency;
`getProductsNeverSold`, `getCatalogOverview` and `getLocationBreakdown` complete the catalogue and
location reads; `listBrands` is a reference lookup like `listLocations` and `listCategories`; and
the two research tools are the gated web-research fallback described in Guide 17. `getReorderNeededProducts` (Phase 11A)
returns the ACTIVE products at or below their minimum, flagged `OUT_OF_STOCK` or
`LOW_STOCK`. `listLocations` and `listCategories` (AI-14) are reference lookups: they answer *"which
locations/categories do I have"* and resolve a name whose exact form is unknown. They read the
same records as `GET /api/locations` and `GET /api/categories`, which are authentication-only,
and are gated on `inventory.view` / `products.view`. No tool writes.

`getInventory`, `getProductsByLocation` and `getInventoryHistory` accept a location by
`locationId` **or** by its exact `location` name (AI-15); `searchProducts` and
`getReorderNeededProducts` accept a category by `categoryId` **or** its exact `category` name
(AI-16), so a member's own words reach the query without a separate lookup turn. Only an exact,
ACTIVE record of the caller's own business resolves; an ambiguous name returns the candidates
instead of choosing one, and passing both forms is refused.

Every list result states its own page — `count`, `returned` and `hasMore` (AI-18) — so the model
can distinguish a complete answer from a window on a larger set, and a list answer shows at most a
handful of rows as examples with the remainder read in the app.

Each tool must:

1. Receive the authenticated user context.
2. Determine the user's business.
3. Validate authorization.
4. Query only permitted data.
5. Return structured data to the AI service.
6. Never expose unauthorized records.

The model must not construct arbitrary MongoDB queries.

---

# 23. AI Tool Example

User:

```text
"What products are low in stock?"
```

Conceptual flow:

```text
User
 ↓
Mobile
 ↓
POST /api/ai/chat
 ↓
Backend Authentication
 ↓
AI Service
 ↓
AI decides to use:
getLowStockProducts
 ↓
Backend validates user/business
 ↓
MongoDB query
 ↓
Structured result
 ↓
AI generates response
 ↓
Mobile
```

The AI response should be based on the returned database data.

---

# 24. AI Hallucination Protection

The AI must not fabricate:

- Product quantities
- Product prices
- SKU values
- Inventory history
- Locations
- Stock levels
- Business records

If required data cannot be retrieved, the AI should clearly state that the information is unavailable.

The AI should distinguish between:

```text
Database fact
```

and:

```text
AI-generated explanation
```

---

# 25. AI Security

Never expose:

- AI API keys
- MongoDB credentials
- Internal database connection strings
- Internal authorization details

to the mobile application.

AI credentials must remain server-side.

AI requests must be authenticated and rate-limited.

The AI must not be able to bypass backend authorization.

---

# 26. AI Provider Abstraction

The backend should provide an abstraction similar to:

```text
AIService
├── provider
├── generateResponse()
├── executeTools()
└── handleConversation()
```

Providers:

```text
OpenRouterProvider        (Anthropic-compatible gateway; the only shipped provider, AI-25)
```

The gateway provider speaks the Anthropic Messages wire through one shared mapping layer, so a
gateway is a configuration over that layer rather than a second protocol implementation. The direct
Claude and Gemini providers were removed in AI-25 (both are reachable through this gateway as model
choices); the interface and the wire layer stay so a direct provider can return cheaply. `openrouter` additionally requires `AI_MODEL_OPENROUTER`: it fronts many models with
different tool-calling ability, so the assistant model is named explicitly rather than defaulted.

Provider selection is server-side only (`AI_PROVIDER`). Keys never reach the mobile application, and
`AI_PROVIDER` stays `openrouter` unless an operator changes it — adding a provider does not switch one.

The application should be able to switch providers through configuration without rewriting inventory logic.

---

# 27. AI Conversation Storage

V1 may store:

```text
AIConversation
├── _id
├── businessId
├── userId
├── title
├── createdAt
└── updatedAt
```

Messages:

```text
AIMessage
├── _id
├── conversationId
├── role
├── content
├── model
├── toolsUsed
├── usage
└── createdAt
```

Possible roles:

```text
USER
ASSISTANT
TOOL
```

Sensitive information should not be unnecessarily stored in conversation history.

---

# 28. RAG / Vector Search

RAG is NOT required for V1.

Future architecture may use MongoDB Atlas Vector Search for:

- Product documentation
- Business policies
- Supplier documents
- Internal manuals
- Uploaded documents
- Semantic search

Possible future architecture:

```text
Documents
 ↓
Chunking
 ↓
Embeddings
 ↓
MongoDB Vector Search
 ↓
Relevant Context
 ↓
AI Model
 ↓
Response
```

Do not introduce this complexity during V1 unless specifically required.

---

# 29. Authentication

Authentication uses:

```text
Firebase Authentication     identity      — "who is this person?"
Inventory AI JWT + session  authorization — "what may they do?"
Email + Password            legacy credential, retained for pre-Firebase accounts
bcrypt                      legacy password hashing
```

The backend must validate authentication on protected routes.

## Firebase Authentication (Identity Provider)

Firebase Authentication is the **identity provider**. It answers *who is this person?* — nothing more.
The Inventory AI backend answers *which Inventory AI account and business does this person belong to,
and what are they allowed to do?*, and MongoDB remains authoritative for `userId`, `businessId`,
`role`, account status, permissions, business status, subscription/billing state, application
sessions and audit records.

**Planned authentication methods:**

| Method | Status |
| --- | --- |
| Email/password via Firebase Authentication | **Implemented** (Phases 32B–32E) |
| Google via Firebase Authentication | **Implemented** (Phase C, native `@react-native-google-signin/google-signin`) — existing-account Android flow E2E verified 2026-09-26; the new-identity path is environment-blocked |
| Facebook via Firebase Authentication | **Planned — not implemented** |
| Apple Sign-In | **Future scope — not part of the current implementation** |

### The Exchange Boundary

Firebase ID tokens are accepted at **two** boundaries and nowhere else:

```text
POST /api/auth/firebase/exchange     PUBLIC         verified token -> Inventory AI session
POST /api/auth/firebase/register     PUBLIC         verified token -> new Business + OWNER user
POST /api/auth/firebase/link         AUTHENTICATED  verified identity -> the CALLER'S OWN account
```

The two public routes are the exchange boundary proper: the caller holds no Inventory AI JWT, which
is why they must prove an identity instead. The server verifies the ID token, uses the verified
Firebase UID, resolves the MongoDB user **by `firebaseUid`**, applies the existing user and business
status checks, and mints the existing Inventory AI JWT and session. An unresolved UID answers the
existing registration-required behaviour.

`POST /api/auth/firebase/link` accepts an ID token for the opposite purpose and in the opposite
direction: the caller is **already** authenticated, and the token names an identity to be attached to
the account the caller's own session already resolves to. It creates no session, resolves no account
from the token, and cannot name an account. See *Safe Account Linking* below.

Three invariants govern these boundaries:

- **A Firebase ID token must never become the application's long-lived API bearer credential.** It is
  exchanged **once** for an Inventory AI access token. The API accepts Inventory AI tokens only.
- **The exchange is UID-authoritative. It never resolves an account by email.**
- **The link boundary never resolves an account from an identity.** The account is the authenticated
  caller's and the identity is the verified token's, so neither side of the association is read from
  a request body.

**On the link route, a rejected ID token is answered `400`, not `401`, and the distinction is
load-bearing.** The mobile client treats a `401` or `403` response to a request that carried a token
as session loss and clears the session. The link route is authenticated, so a `401` there would mean
"the Firebase credential was bad" and be acted on as "your Inventory AI session is gone" — signing a
user out over an unrelated failure. `400` states what actually happened and falls outside that rule.
The error `code` is unchanged, so a client branching on codes needs no second branch.

### Password Authority for Linked Accounts

When an account carries a `firebaseUid`, **Firebase is the authentication authority for it and the
retained `passwordHash` is not a second authentication door.** `POST /api/auth/login` refuses such an
account with `403 FIREBASE_SIGN_IN_REQUIRED`, after the password comparison and the status check — so
the refusal does not reveal whether the account exists — and before any session is written, so no
half-login can be left behind. This guard is **not to be removed or weakened**.

**Phase 32H made that population reachable for the first time** — it added the only operation that
writes `firebaseUid` onto an existing password account — and **Phase 32K decided and implemented the
consequence**: because Firebase holds such an account's credential, Inventory AI local password
operations **do not apply** to it.

- `POST /api/auth/change-password` is **refused** with `409 PASSWORD_NOT_APPLICABLE`, **before** the
  current-password comparison and before every effect — no hash rewritten, no `passwordChangedAt`
  stamped, no session revoked. That position is deliberate: placed after the comparison, a
  Firebase-native account (no hash) would report `400 INVALID_CURRENT_PASSWORD` while a linked account
  (hash retained) would report the boundary refusal — two different answers to one question, decided by
  whether an inert hash happens to remain on the document. `409`, not `401`/`403`, because the mobile
  client treats those two statuses on a token-bearing request as session loss and would sign the user
  out of a perfectly valid session.
- `POST /api/auth/forgot-password` takes the **silent exit**: one uniform `202`, with **no token, no
  email and no audit row**. Distinguishing such an address would be the account-existence oracle the
  recovery design refuses to be, and the check sits *after* the tenant check so it adds no new timing
  signal to a path whose residual database-work term is only partially mitigated. `POST
  /api/auth/reset-password` refuses with the generic `400 INVALID_RESET_TOKEN`, **last, immediately
  before the write**, so no local credential is ever created for such an account.

**No retained `passwordHash` is deleted, and none is created.** A hash a linked account already holds is
**retained and made inert** — deleting it now could make a later unlink irreversible, which is why that
lifecycle question remains open below. A **Firebase-native** account holds no hash at all.

**The timing equalizer is never a credential** (Phase 32K). `passwordHash` is optional, so a comparison
must still run — and still run at bcrypt cost — when an account has none, or a hashless account would be
distinguishable from a real one by response time. Its *result*, however, must never be accepted: a
placeholder that is a valid bcrypt hash of a known string would otherwise become a working password.
Both comparison sites — login and `change-password` — therefore route through one helper whose contract
is **no stored hash means no password**, so the timing property is preserved and acceptance is not.

The client learns whether local password management applies through a **provider-neutral capability** —
`authMethods: { password: boolean }` — published by both the public user DTO (`toPublicUser`) and
`requireAuth`'s `req.user`, so the two surfaces cannot disagree. The `firebaseUid` behind it is **never**
exposed: it is the identity join key this design keeps server-side. Nothing about the Phase 32E guard
itself changed — it is intact and unweakened, and the link route does not offer a second way in.

## Provider Identity Linking Policy

**A provider identity is NEVER automatically linked to an existing Inventory AI account merely because
the email address matches.** Email is **not** an account-linking join key.

Authenticating a provider identity is **not** proof of ownership of an existing Inventory AI account.
If an identity asserting `john@example.com` were merged into an existing `john@example.com` account on
the strength of the address alone, then anyone able to obtain a provider account bearing a victim's
address would receive that victim's session — their `businessId`, their role and their entire tenant's
data. A provider that does not verify addresses, or that allows an address to be changed later, makes
that reachable in practice rather than in theory.

The server therefore stays **UID-authoritative**, and linking is a deliberate act with an explicit
proof of ownership, never a side effect of matching an address.

### Safe Account Linking (server-side boundary implemented — Phase 32H)

Linking is an **explicit account operation performed by an already-authenticated user**:

```text
Inventory AI authenticated session
        ↓
user explicitly chooses "Connect Google" / "Connect Facebook"
        ↓
provider authentication
        ↓
verified Firebase credential
        ↓
Firebase account linking
        ↓
the existing Inventory AI account is unchanged
        ↓
businessId / role / status remain authoritative
```

Two constraints apply:

- **The provider UID must come from the verified Firebase credential or token, and never from the
  mobile request body.** As with `businessId`, `role` and `status`, a client-supplied provider
  identity is untrusted input.
- **Linking during a sign-in attempt requires an explicit ownership/recovery proof flow** before it
  may attach a provider to an existing Inventory AI account. A sign-in is evidence about an identity;
  it is not evidence about an account.

**The diagram's first half is implemented; its last step is not.** `POST /api/auth/firebase/link`
records that a verified Firebase identity belongs to an account that has already proved itself, and
that is the entire server-side boundary:

```text
POST /api/auth/firebase/link     authenticated, 200
body: { idToken }
-> { linked: boolean, user }
```

What it does, and what it deliberately does not:

- **The account comes from the caller's session** (`req.user.id`), never from the request. There is no
  `userId`, `businessId`, `firebaseUid`, `role` or `status` field in the accepted payload, so a body
  naming any of them is inert rather than rejected — the handler holds no client-supplied identity to
  forward.
- **The identity comes from the verified token's UID.** It is never compared with the account's email,
  never used to find an account, and never used to resolve a conflict. A provider that supplies no
  address links exactly as well as one that does.
- **It writes exactly two fields: `firebaseUid` and `emailVerified`.** It cannot move an account
  between businesses or change its role, because no code path writes `businessId`, `role` or `status`.
- **Four lifecycle cases, in an order that matters.** The same identity on the same account is an
  idempotent success (`linked: false`, no write, no audit row). An account that already owns a
  *different* identity is refused. An identity that already belongs to *another* account is refused
  and never transferred, merged or re-pointed. An identity belonging to nobody is attached — which is
  safe only because the caller has already proved they own this account.
- **Both refusals are one `409`** with one code and one generic message that names no account, tenant,
  role or Firebase UID, so the two are indistinguishable to the caller. The precise reason and the UID
  go to the audit trail and the server log, where the reader is the tenant's own operator rather than
  the caller — and the UID itself is kept out of the audit row, because that row is readable by every
  ADMIN of the business while a conflicting UID may name a person in a different one.
- **Concurrency is resolved by the database, not by a check.** The attachment is one conditional
  update that applies only while the account is still unlinked, and the `firebaseUid` unique index is
  the last line of defence behind the pre-check, so two accounts racing for one identity cannot both
  win.

**Still not implemented:** the provider half. There is no "Connect Google" or "Connect Facebook" UI, no
provider credential acquisition, no OAuth redirect flow, no `unlink` route, and no provider field on
any model. Firebase's own provider linking is performed by the Firebase client SDK against the
signed-in Firebase user; the server neither performs it nor has an API for it, and attaching a
provider is not a server-side operation at all — the UID does not change, so from the Inventory AI
side a Firebase account with several providers is simply one `firebaseUid`.

> **Superseded in part 2026-10-07.** Three of the claims above no longer hold. **A "Connect Google" UI
> exists** — the Profile action is **"Add Google sign-in"** (Phase C3; Phase 32M before it) — and it
> **acquires a provider credential**: `nativeSignInWithGoogle` (`mobile/lib/firebase-native.ts`) runs the
> native Google consent, wraps Google's `id_token` with `GoogleAuthProvider.credential` and calls
> `signInWithCredential`, and `connectFirebase` (`mobile/lib/auth.tsx`) then sends the resulting Firebase
> ID token to the shipped `POST /api/auth/firebase/link`. **There is still no OAuth redirect flow** (the
> browser path was retired by Phases F1/F2) **and no provider field on any model** — both remain true. And
> **the `unlink` route is absent again, for a different reason**: Phase 32L *shipped* it and Phase A / F-1
> (`6e2252f`) *removed* it, so its absence is a removal rather than an omission. The closing sentence still
> stands in substance: Firebase's own provider linking (`linkWithCredential`) is performed by no code path
> in this implementation — the client authenticates with Google at Firebase, and the server attaches the
> verified UID.

### Facebook and Missing Email

The `User` model requires an email. Facebook may not provide a usable email address for every
identity — its email permission is not granted by default, and an account may be phone-only.

Therefore:

- **Never invent an email address.**
- **Never derive a fabricated email from a Facebook UID.**
- If a Facebook identity lacks a usable email, the onboarding flow **must require email completion**,
  explicitly handled, before an Inventory AI user is created.

That onboarding behaviour is **not implemented**; it belongs to the future Facebook phase.

### Unlink, Revocation and Last-Method Protection

Unlinking is a client-side Firebase operation, so the **server cannot observe it**; Firebase refuses to
unlink a user's last provider, but its notion of "last method" covers only Firebase methods and is
unaware of a retained `passwordHash`. The application, meanwhile, refuses password login for any
account carrying a `firebaseUid`. **An unlink policy and last-authentication-method protection that
account for both sides are OPEN** and must be settled before an unlink capability ships. Phase 32H
implemented **no** unlink capability of any kind, server-side or otherwise, and left this open rather
than deciding it.

**Superseded in part, 2026-09-26 (Phase 32L — see `docs/DEVELOPMENT_ROADMAP.md` §27Q).** The paragraph
above is the Phase 32H record and is not rewritten. **The unlink policy is now settled and the
server-side capability shipped:** one authenticated route, `POST /api/auth/firebase/unlink`
(`requireAuth` + controller, no permission), detaches the caller's **own** `firebaseUid`. **Policy B is
the policy, and it is the last-authentication-method invariant made structural:** an account may leave
Firebase authority **only by establishing a NEW local password in the same transition**, so it never
passes through a zero-authentication-method state; the retained legacy hash is **REPLACED, never
re-enabled**, and the write touches only `firebaseUid`, `emailVerified`, `passwordHash` and
`passwordChangedAt`, so an unlink can never move a tenant or change a role. Stale authentication answers
`409 FIREBASE_REAUTHENTICATION_REQUIRED` (a 300-second window, enforced server-side from the signed
claim). **The premise above was also refuted by measurement, and the two measurements are distinct
facts:** in the **last-provider** measurement the unlink **succeeded on the account's final provider and
left the Firebase account with zero providers**, which is what refutes "Firebase refuses to remove the
last provider"; in the separate **390-second** measurement a provider unlink was **accepted** at an
authentication age where `updatePassword` was **refused** — a finding about *recency* rather than about
the last provider. Firebase's "last provider" protection therefore cannot be relied on, and
**last-authentication-method protection is enforced server-side and never delegated to Firebase**.
**Residual, recorded and not closed:** Firebase's own provider set remains a client-side operation this
server cannot observe; the server owns only the MongoDB `firebaseUid` detachment, and no server-side
provider-unlink capability was faked.

> **Superseded in part — 2026-10-01 (`Phase A / F-1 — 6e2252f4c63a7bd98e1d63a4703f21ab236c93a9`).** The
> server-side unlink capability the note above records as shipped was **REMOVED**, not deprecated: the
> route `POST /api/auth/firebase/unlink`, its service and its two audit actions no longer exist in the
> committed tree, and the operation was re-scoped into a **credential change** — so no reachable path
> clears `firebaseUid`. **The Policy B measurements above remain valid history**; only the capability is
> gone. See the Phase F-1 correction in `CLAUDE.md` and `docs/AUTH_SECURITY_MASTER_CHECKLIST.md` §8.

Ending an Inventory AI session revokes that session only. It never revokes the Firebase identity, and
disabling an Inventory AI user does not disable the corresponding Firebase user — the exchange refuses
the disabled account, which is what denies access.

## Provider-Neutral Sessions

**There must remain one unified Inventory AI session representation regardless of authentication
provider.** There are no provider-specific session types: a session is the same record whether the
identity was proved by a legacy password or by any Firebase provider.

**No provider field may be added to the session model** merely because Google or Facebook is being
added. Adding a provider adds *credential acquisition*, not a session path — every provider reaches
the server through the same exchange and inherits the same check order, so a disabled account or an
inactive business cannot be bypassed by choosing a different sign-in method.

### Open Items (decided as open, not as resolved)

These are **not settled**. They are listed so they cannot be settled silently in code, and each
requires an explicit owner decision before the phase that would implement it:

| Open item | Blocks |
| --- | --- |
| The unlink policy and last-authentication-method protection — **RESOLVED FOR THE SERVER-SIDE PATH 2026-09-26 (Phase 32L): the policy is Policy B** (an account may leave Firebase authority only by establishing a new local password in the same transition, so the server-side last-authentication-method invariant holds structurally). **Residual, recorded and NOT closed:** Firebase's own provider set is a client-side operation the server cannot observe. | ~~Any unlink capability~~ — the server-side capability shipped in Phase 32L; the residual above is recorded rather than closed. **Annotated 2026-10-01 (`Phase A / F-1 — 6e2252f4c63a7bd98e1d63a4703f21ab236c93a9`):** the server-side capability is **REMOVED**, not deprecated — the route, its service and its two audit actions are gone from the committed tree, and the operation was re-scoped into a credential change; the residual above stays recorded rather than closed. See `CLAUDE.md` and `docs/AUTH_SECURITY_MASTER_CHECKLIST.md` §8. |
| ~~Whether `emailVerified` is enforced~~ — **DECIDED and IMPLEMENTED:** enforced at the Firebase register/exchange/renew boundaries (`400 EMAIL_NOT_VERIFIED`); the verification **mechanism** is being superseded by AUTH-04 (a custom 6-digit code, §29). | Provider sign-in that relies on a provider-asserted address |
| M1 (native SDK) vs M2 (`expo-auth-session`) for the mobile provider integration — **CLOSED 2026-09-25 (Phase F1): RESOLVED as M1, the shipped architecture; M2 is superseded and its browser machinery removed** | ~~All Google/Facebook mobile work~~ — this row no longer blocks Google, which ships natively. Facebook Login remains future scope, and it inherits the M1 decision |
| The Facebook missing-email onboarding flow | Facebook Login |
| The remedy, if any, for the unhealable orphan (a legacy account whose email already has a Firebase identity that can never resolve to it) | The legacy migration/linking phase |
| `google-services.json` / `GoogleService-Info.plist` storage and whether they are committed | Any native provider configuration |
| Whether Firebase takes over the password reset flow, and the disposition of the Phase 26B/27 artefacts if it does | Password recovery |

**Retired by Phase 32K.** The linked-account disposition of `change-password` and the password reset
flow was previously listed here as a live defect. It is no longer open — Phase 32K decided and
implemented the boundary described under *Password Authority for Linked Accounts* above. The audit
accompanying that phase also **corrected the finding's wording**: an ordinary `change-password` attempt
by a Firebase-native account **fails** `400 INVALID_CURRENT_PASSWORD` (a hashless account has no current
password to verify) rather than reporting success; it was the **reset** flow that reported success while
writing an unusable credential, and `change-password` behaved as first described only for a linked
account that still carries a hash.

One further fact is **UNVERIFIED**: whether Firebase's `auth:import` accepts bcrypt hashes. That matters
only to a bulk migration, which the locked direction below rules out for the current test-only users.
The React Native Firebase config-plugin question is resolved: M1 is the shipped architecture, and the
plugin runs on Expo SDK 58 (`@react-native-firebase/app` and auth in `mobile/app.json`), with a
device-verified build (§27J, §27AZ).

## Server-Side Sessions

An access token is **not** the whole session. Signing a token creates a session
record, and the token's `jti` claim names it. An access token therefore carries:

```text
sub   the user id
jti   the id of the session record
iat   issued-at
exp   expiry
iss   issuer (AUTH-02)
aud   audience (AUTH-02)
```

It carries nothing else. Role, status and `businessId` remain database-derived on
every request (§30), and a session record holds no authorization data either — a
session grants nothing except continued authentication, so a stolen or forged one
cannot escalate anything.

`middlewares/authenticate.ts` is the single authentication choke point and
requires all of the following before a request proceeds: a valid HS256 signature,
an unexpired token, a `sub` that is a real user, a **`jti` that names a session
which exists, belongs to that user, is not revoked and has not expired**, an
ACTIVE user, and an ACTIVE business. A token with no `jti` is rejected outright.

The session record (`server/src/models/session.model.ts`) stores the user, the
`jti`, a cosmetic device label, `createdAt`, `lastUsedAt`, `revokedAt` and
`expiresAt`, and is removed by a TTL index once it expires. Because the record is
consulted on every authenticated request, a session can be ended server-side:

- **Sign out** ends the session the request was authenticated with. The client
  never names a session, a user or a business — the server takes it from the
  token's own `jti`. This is what makes logout real rather than a client-side
  state change.
- **Per-session revocation** ends one session belonging to the caller, so a single
  device can be signed out while every other session keeps working. The owner is
  part of the lookup, so another user's session is unreachable and answers the
  same `404` as an unknown id.
- **Sign out everywhere** ends every open session for the caller, the current one
  included.
- **A per-account cap** bounds how many sessions one account may hold open: **20**
  (`MAX_ACTIVE_SESSIONS_PER_USER`). Every sign-in, reinstall and exchange mints a
  row that lives for the full 14-day cap, so without a bound a token taken from an
  old device stays live for a fortnight however often the owner signs in
  elsewhere. The rule runs **at creation only** and revokes the **oldest** sessions
  rather than refusing the newest sign-in, so the device in the member's hand keeps
  working; each eviction writes a `SESSION_REVOKED` audit row with
  `reason: "session-cap"`. It is best-effort by design — the login has already
  succeeded, so a cleanup failure is logged and the next sign-in tries again, which
  is why 20 is a **bound and not a guarantee**. It is deliberately not a device
  policy: a member cannot see or choose which device goes, so a tighter number
  would be a product decision nobody has made.

All are self-service operations on the caller's own sessions and require no new
permission: they are authenticated routes, not capability-gated ones. The three
routes are `POST /api/auth/logout` (with `{ "all": true }` for sign out
everywhere), `GET /api/auth/sessions` and `DELETE /api/auth/sessions/:id`. The
session listing never exposes a token or a `jti` — it names the current session
with a `current` flag instead, which is all a client needs to identify itself.

Two consequences are deliberate and were accepted when this was introduced:
tokens issued before server-side sessions existed carry no `jti`, so they are
rejected and every user signs in once more; and **there is no refresh-token
rotation** — a session ends when it is revoked or when its token expires, and a
new token is obtained by signing in again.

### Session Renewal (AUTH-03)

Because a token lives one hour while its session is capped at 14 days, a client must be able to
obtain a **new token for the same session** without signing in again and without creating a second
session.

```text
POST /api/auth/renew   200 on success; requires BOTH credentials
```

Renewal requires the current Inventory AI access token **and** a fresh Firebase ID token. The route
is **authenticated** — `requireAuthForRenewal` verifies the token first, including one whose `exp`
has already passed (fixed 2026-10-22; see below) — so the account comes from `req.user.id`
and the session from `req.auth.jti`, both taken from the token that authenticated the request; the
body carries only `{ idToken }`. A client can therefore never name another user, another business or
another session. The route is **per-IP rate-limited** (default 120 per 15 minutes, configurable via
`AUTH_SESSION_RENEW_RATE_LIMIT_WINDOW_MS` / `AUTH_SESSION_RENEW_RATE_LIMIT_MAX`), answers
`429 SESSION_RENEW_RATE_LIMITED` with a `Retry-After` header, and treats that 429 as **transient** —
it neither ends the session nor loops. No audit row is written per renewal.

**The token being replaced may already be expired** (fixed 2026-10-22). Renewal is the client's
recovery path as well as its proactive one: when a request is refused `SESSION_EXPIRED`, the client
calls `POST /api/auth/renew` with **the token that was just refused** and retries exactly once. That
can only work if the route accepts an expired token that still names a **live** session, so it
authenticates with `requireAuthForRenewal` rather than `requireAuth`. Exactly one thing is relaxed —
`exp`: the signature, algorithm, issuer and audience are still verified, the `jti` is still required,
the account must still exist and be `ACTIVE`, the password-change rule still applies, and the named
session must still be live (revoked, capped or unknown → `401 SESSION_REVOKED`; a token issued before
a password change → `401 SESSION_INVALIDATED`). Nothing about data access changes: the route
authorizes no read and no write, it verifies a fresh Firebase identity with `checkRevoked`, and it
mints a token for the session it was given. Before the fix the route sat behind `requireAuth`, so the
recovery call was refused by the same middleware that refused the request — measured on a phone as a
forced sign-in on a live 14-day session.

Renewal re-issues a token for the **same `jti`**: it never creates a session row and never mints a
new `jti`; it **never extends the session's `expiresAt`**, so the 14-day absolute cap is untouched
and renewal cannot prolong a session beyond its original cap; and the new token's `exp` is always
later than the old token's, which is what makes a renewal observable.

Firebase verification uses `checkRevoked: true` (AUTH-01), and the **Firebase UID is the only
identity match** — an ID token whose uid differs from the account's `firebaseUid`, or an account
with none, is refused with `409 FIREBASE_IDENTITY_CONFLICT`. Email is never a join key. The verified
**email-verification gate applies at issuance and at renewal**: an unverified identity is refused
with `400 EMAIL_NOT_VERIFIED` on both `POST /api/auth/firebase/exchange` and `POST /api/auth/renew`.
There is no permanent legacy exception, and registration is unchanged. A live session is **not**
retroactively terminated if a claim later becomes false — enforcement is at issuance and renewal
only, and `middlewares/authenticate.ts` is unmodified.

Login, exchange and renewal all report the client's **authentication horizon**: `tokenExpiresAt`
(the exact `exp` of the token just issued) and `sessionExpiresAt` (the existing session's absolute
cap). The horizon the app **displays** is `min(tokenExpiresAt, sessionExpiresAt)` — the earlier
boundary wins — but that is not what schedules a renewal, because renewal never moves the cap. The
client renews **proactively** only when the **token's own `exp`** is inside a 10-minute window and
the token, not the cap, is the boundary about to be crossed; when the cap is the earlier of the two
nothing is renewed, since the session ends there regardless. Renewals are also **paced**: at most
one per 60 seconds, unless the current token is within 20 seconds of expiry (which is never paced
away). The app also renews on a return to the foreground when the same rule says a renewal is due.
Without the two qualifications the last ten minutes of every session — and any deployment whose
`JWT_EXPIRES_IN` is shorter than the window — renewed on **every request**, and each renewal handed
the screens a new token, so every screen whose load effect depends on the token reloaded: measured
on the phone on 2026-10-22 at **121 renewals and 122 `/api/dashboard` requests in three minutes**,
ending only when the server's own 120/15-minute renewal limiter refused the 121st.

Renewal is **single-flight**, and staleness is handled by an **authentication epoch**: a response
belonging to an epoch that has since ended (a sign-out, a fresh sign-in) is discarded rather than
applied, because clearing the in-flight promise does not cancel the request. Failures are classified
by **application error code, never by HTTP status** — a plain 401 says nothing about recoverability,
since `SESSION_EXPIRED` (recoverable) and `SESSION_REVOKED` (terminal) are both 401s. A recoverable
failure retries the original request **exactly once**; terminal errors never renew; a transient
failure degrades gracefully without ending the session, and `BUSINESS_NOT_ACTIVE` preserves
authentication. No refresh token and no new durable state exist.

## Account Deletion (self-service)

`DELETE /api/auth/me` closes the caller's own account. It is **authenticated** and carries no
capability: the subject is `req.user.id`, no id in the request could name another account, and the
caller must re-authenticate with the current password or a fresh Firebase ID token. The route is
rate-limited, accepts the confirmation word `DELETE`, and issues no session.

The row is not hard-deleted. It becomes a tombstone: `status: DELETED`, `deletedAt`, the real name and
email replaced, `firebaseUid` and `passwordHash` removed, and `passwordChangedAt` stamped so an
already-issued token cannot outlive the deletion. The person's sessions, password-reset and
email-verification records, invitations addressed to them, and AI conversations and messages are
removed. In the account-only path, audit rows are kept with `userId: null` and one `ACCOUNT_DELETED`
row records the event; when the whole tenant closes, its audit trail is removed with it.

The Firebase identity is deleted first, in the same operation. If that deletion fails, the database row
is left intact rather than becoming an orphan. When another active member remains and the caller is the
only active OWNER, the request is refused `409 LAST_OWNER_TRANSFER_REQUIRED` until ownership is
transferred. When the caller is the only active member **and** the OWNER, the whole tenant is removed
with the account — products, stock, movements, purchase orders, suppliers, locations, categories, the
audit trail and assistant history — through the same teardown plan every cleanup uses. A non-owner who
is the only active member leaves the tenant with its owner.

The app exposes the flow at **Profile → Delete account**; `GET /account-deletion` is the public web
page that explains it. A repeat request on a surviving tombstone converges: no destructive work is
repeated and no second identity or audit row is created.

## Password Recovery

> **Current mobile path (AUTH-06, 2026-10-20).** The shipped app resets a password with a **six-digit
> code entered in the app**, not by opening a link. The link flow below remains implemented for the
> server page; the code flow is described in "Password reset by six-digit code" below.

A user who has forgotten their password can recover access through an emailed, single-use reset link.
The link flow has two routes, both **public and unauthenticated** — the caller cannot authenticate,
which is the whole point — and both POST-only:

```text
POST /api/auth/forgot-password   202, always
POST /api/auth/reset-password    200 on success
```

Both are rate-limited. The code flow below adds three more public, POST-only routes.

### `POST /api/auth/forgot-password`

**The response is identical for every caller.** Requesting a link for an address with no account, for
a disabled account, for an account whose business is not active, and for an address that exists and is
deliverable all answer the same `202` with the same message body, so the route cannot be used to
discover which addresses have accounts. This is an invariant, not a UI convention, and it is enforced
structurally: the service returns no value on any non-error path, so the route has nothing it could
reflect.

The one exception is **server configuration, not account state**: when mail delivery is not configured
the route answers `503` with a fixed message that names no variable, provider or transport detail.
That answer is safe because it is decided **before** the account is looked up — every caller receives
it identically, so it distinguishes nothing about any account — and it is a `503` so an operator can
see that recovery is broken. A message that *could* be sent but fails in transit is handled the
opposite way: the failure is recorded server-side and the caller still receives the same `202`, because
by then the account is already known to exist and any distinguishable answer would be an
account-existence oracle. **Since Phase 28 B1 the send is dispatched without being awaited**, so that
record is written from the detached background path (`logDetachedMailFailure` in the recovery service)
after the response has already been sent — the caller's `202` is unaffected by it, and the transport
failure remains invisible in the response either way.

A reset link is valid for 30 minutes and can be used once.

### `POST /api/auth/reset-password`

Accepts the emailed token and the new password. On success it answers `200` with a message body and
nothing else — no token, no user, no password — and every session belonging to that user is ended, so
a reset also evicts anyone already signed in with the old password. The user's `passwordChangedAt` is
updated, which independently invalidates every access token issued before the reset.

The new password is held to the same policy as `POST /api/auth/change-password`; the two routes share
one validator and cannot drift apart. A `confirmPassword` field is accepted and checked **before** the
token is presented, and takes no part in the reset itself — so a mistyped confirmation is rejected
without touching the token, and a valid link cannot be spent by a typo.

The token is consumed the instant it is claimed, and consumption is **fail-closed**: a token is never
returned to circulation by a later failure, and no failure path releases it. A second use of the same
link — concurrently, or after any subsequent failure — is rejected. Only one link is live per user at
a time, so requesting a new one invalidates the previous one, and a token is stored only as a hash, so
the database itself yields nothing that can be replayed.

### Errors

Both routes answer with an error `code` and a message:

- An invalid, unknown, expired, already-used or no-longer-valid token →
  `400 INVALID_RESET_TOKEN`. One code and one message cover every one of those cases, so a caller
  cannot tell them apart.
- A new password that fails policy, or a malformed request → `400 VALIDATION_ERROR` with a `fields`
  list.
- Too many attempts → `429 PASSWORD_RESET_RATE_LIMITED`. **Every** attempt counts, including
  successful ones and including requests for addresses that have no account: there is no failure to
  exempt, because those two paths are deliberately indistinguishable.
- Mail not configured on the server → `503`.

Error responses never carry a stack trace, a database or provider detail, an environment-variable
name, or any part of the message that was sent (§33).

### Mobile client

The mobile application implements the user-facing half of this surface, on `/forgot-password` and
`/reset-password`. Both are public screens, so they render whether or not a session exists and never
wait on authentication.

- **A password-reset email link targets the mobile app's custom scheme**, not a web page: the reset
  URL is `inventoryai://reset-password?token=<token>`, which is the value `PASSWORD_RESET_URL` carries
  (§35). Universal Links and Android App Links are deferred, so a link opened on a device without the
  app installed has no web fallback.
- **The reset screen reads the token from the incoming URL parameter** and from nowhere else. A link
  with no token, an empty token or a malformed one is rejected locally and no request is made. The
  client imposes no rule on the token's shape beyond that.
- **The token is submitted only in the body of `POST /api/auth/reset-password`.** It is never
  displayed on screen, never written to a log by application code, never persisted to device storage,
  and never copied into another navigation. It leaves the app in exactly one place.
- **A successful reset clears the client session and returns the user to Login.** Clearing is required
  before navigating, because the Sign In screen redirects an authenticated client into the app — so a
  user whose reset succeeded would otherwise be sent straight back into the app instead of being asked
  to sign in with the new password. No client session survives a reset, matching the server, which ends
  every session the account held.

### Password reset by six-digit code (AUTH-06, current mobile path)

```text
POST /api/auth/password-reset/code      202, always
POST /api/auth/password-reset/verify    200 + a one-time reset authorization
POST /api/auth/password-reset/confirm   200, password replaced
```

`/code` mints a six-digit code (10-minute lifetime, five attempts, 60-second resend cooldown) and sends
it through the mail boundary. It answers the same `202` and the same sentence for a known address, an
unknown one, an ineligible account and a delivery failure; the one `503` is a configuration refusal
checked **before** the account lookup. `/verify` checks the code and returns a short-lived, single-use
authorization (15 minutes); it accepts no password and issues no session. `/confirm` accepts that
authorization, not the code, and the new password; it ends every session the account holds, stamps
`passwordChangedAt`, requests revocation of the Firebase refresh tokens (best effort), and issues no
session.

The code and the authorization are stored only as purpose-separated keyed digests, and both are
domain-separated from the email-verification digests that share the same pepper. The mobile screens are
`/forgot-password`, `/reset-password-code` and `/reset-password-new`.

### Known limits

Both properties below are documented and accepted, and neither is fully closed. They are recorded in
`docs/DEVELOPMENT_ROADMAP.md` §27B "Accepted / Deferred Security Risks", with Phase 28 B1's own record
in §27D.

- `forgot-password` is a **timing oracle** on account existence: the responses are uniform, but the
  time taken is not. **Phase 28 B1 partially mitigated this, and it is NOT closed.** An unknown address
  costs one indexed lookup; a known one additionally costs writes, an audit row and — until Phase 28 B1
  — an outbound mail request, which was awaited before the response and was the dominant, most easily
  separable term of the difference. That transport request is **no longer on the request path**: the
  send is dispatched unawaited after the durable writes, so the largest and most measurable component
  is gone. **What remains is database work**, and it is explicitly **not** claimed to be eliminated. No
  delay is injected to mask it.
- **Distributed flooding of one address is not bounded, and this is unchanged.** The per-address limit
  is keyed by source address *and* email, and the per-source limit never sees a rotating attacker, so
  mail volume to a single victim is not capped across sources. Closing it needs a shared store (Redis),
  which is out of V1 scope by decision.

Future authentication may include:

- Facebook Login — **planned** (§29); approved as a provider, not implemented
- Apple Sign-In — future scope
- MFA — future scope

*(**Google Sign-In was removed from this list when it shipped.** It is **implemented** — see §29.)*

Firebase Authentication **is** implemented as the identity provider (§29). **Google Sign-In is also
implemented** — the native provider SDK (`@react-native-google-signin/google-signin`) is installed and
the existing-account Android flow is E2E verified (2026-09-26), while the new-identity
`REGISTRATION_REQUIRED` path remains environment-blocked. Facebook is the one approved provider still
unimplemented: **no Facebook provider SDK is installed and no Facebook provider route exists.** Apple
Sign-In is future scope and is not part of the current implementation. Enforcing `emailVerified` is
likewise **implemented at the Firebase register/exchange/renew boundaries** (see §29's AUTH-04 note). *(The "likewise not implemented" wording was the pre-2026-09-30 state and is corrected here.)*

Account linking is **half** implemented, and the half matters: since Phase 32H the **server-side
boundary** exists (`POST /api/auth/firebase/link`, authenticated — see §29), while the provider side
does not. There is no "Connect Google", no OAuth redirect, no unlink, and no provider field on any
model. *(**Superseded in part 2026-09-26 (Phase 32L): the server-side unlink boundary now exists** —
`POST /api/auth/firebase/unlink`, under Policy B — while Firebase-side provider unlinking remains a
client-SDK operation the server cannot observe and no provider SDK was installed. This sentence is the
Phase 32F record and is not rewritten.)* The boundary is what Google and Facebook will converge on; it is not Google or Facebook.

> **Further superseded 2026-10-07 (Phase A / F-1).** The 32L note above is itself now historical: Phase A /
> F-1 (`6e2252f`) **removed `POST /api/auth/firebase/unlink`** — route, service, controller handler, payload
> validator, both audit actions and the mobile API wrapper — and re-scoped the operation into a **credential
> change** (Firebase `updatePassword` → the credentials-changed bridge). **There is no unlink capability and
> no unlink route**, and `firebaseUid` is never cleared. The provider side is meanwhile **partly
> implemented**: a Google sign-in UI exists ("Add Google sign-in") and acquires a Google credential, while
> Facebook and Apple remain unimplemented and no Facebook provider SDK is installed.

---

## Firebase-Only Authentication — the Locked Direction (design only; nothing removed)

> **AUTH-04 supersession (2026-10-02).** Within this locked direction, email verification is now a
> **custom 6-digit Inventory AI code delivered by Brevo**, **not** a Firebase verification link, and the
> client resends through Inventory AI rather than native Firebase Auth. A successful confirmation sets
> Firebase's own `email_verified` state through the Admin SDK (`updateUser(uid, { emailVerified: true })`).
> Everything else in this subsection is preserved: Firebase remains the identity provider and the authority
> of record for the final verification state, MongoDB remains authoritative for
> `businessId`/`role`/`status`/permissions/lifecycle, the Firebase UID stays the only join key, and
> `requireAuth` is unchanged. The registration **ordering** gate (no `User`, no `Business`, no JWT and no
> session before verification) is retained, and the server-side `EMAIL_NOT_VERIFIED` enforcement remains.
> This supersedes only the link/resend **mechanism** described below. See design **§14C.10**,
> checklist **§40**, roadmap **§27Y**.

**2026-09-29.** The owner has locked the direction of this subsystem: **Firebase Authentication becomes
the sole authentication authority**, and the application-owned password path is **retired** rather than
carried forward. The premise that makes this affordable is fixed by the owner: **all current MongoDB
users are mocked development/test data**, so **no legacy-user migration, backward-compatibility layer
or bulk `auth:import` is designed, and none is to be built**.

**Nothing described in this subsection has been implemented or removed.** Every route, service, model,
screen and mail module named below still exists and still behaves exactly as the sections above
describe. The authoritative record is `docs/superpowers/specs/2026-09-18-firebase-auth-design.md`
**§14C**; the security record is `docs/AUTH_SECURITY_MASTER_CHECKLIST.md` **§39**; the shipped record is
`docs/DEVELOPMENT_ROADMAP.md` **§27U**.

**What Firebase owns, once this is implemented:** email/password authentication, Google authentication,
password reset/recovery, email verification, and password changes.

**What does not move — and this is the part that must not be misread:**

```text
Firebase Auth      identity          — "who is this person?"
Inventory AI JWT   application session + revocation   ← REMAINS
MongoDB            businessId · role · status · permissions · lifecycle · tenant isolation   ← AUTHORITATIVE
```

- **The Inventory AI JWT and server-side session remain, and this is not negotiable.** `requireAuth` is
the only component that loads the MongoDB `User` **per request**, refuses a token whose `jti` names no
live session, compares the token's `iat` against `passwordChangedAt`, and checks the business's
liveness. Firebase cannot revoke an Inventory AI session, because an ID token is never the API bearer
credential.
- **MongoDB remains authoritative** for `businessId`, `role`, `status`, permissions, business lifecycle
  and tenant isolation. **Business authorization must not move into Firebase custom claims as the
  primary authority**, and no custom claim is introduced, read or trusted. `firebaseUid` remains an
  identity linkage field, not an authorization source.
- **Email/password users must have a verified email before entering the main app.** A Google user is
  verified **according to Firebase's signed `email_verified` claim** — not because the provider is
  Google. **The enforcement *mechanics* are DECIDED (2026-09-29, design §14C.9 — OD-3 resolved), and
  they are enforced by ordering rather than by a new check:** the registration order is Firebase
  account → **verification email sent** → the user verifies → `reload()` confirms
  `emailVerified === true` → **only then** does Inventory AI create the MongoDB `User` **and**
  `Business` (together, with `User.businessId` still required), make the user **OWNER**, and mint the
  Inventory AI JWT + server session. **No `User`, no `Business`, no JWT and no session exist before
  verification**, so there is no half-registered tenant to clean up; a signed-in-but-unverified
  identity is held on a **client verify screen** and may resend through **native Firebase Auth**. That
  is why **`requireAuth` is deliberately not modified**: the Phase 23/24 authorization order and
  status-code contract are preserved, and every already-shipped client stays valid. An unverified
  Google identity is **refused**, not merely warned. The stale `User.emailVerified` problem is
  **bounded, not eliminated** — the gate applies at registration time, and no per-request Firebase call
  is added (the server must not call Firebase on ordinary API requests). The legacy
  `/api/auth/register` path stays **transitional** and is not weakened for this, and **universal**
  verification enforcement becomes possible only once that path is retired. **None of this is
  implemented, and the delivered flow does not exist in the shipped code** — today
  `POST /api/auth/firebase/register` creates the `Business` and the `User` immediately and
  `POST /api/auth/firebase/exchange` mints the session, with `emailVerified` persisted and never
  enforced.

### The credential-change revocation bridge (required before native recovery ships)

A Firebase-native password reset or password change completes **entirely inside Firebase**, on the
client. Because `passwordChangedAt` is the only mechanism that invalidates existing Inventory AI
sessions — and Firebase cannot invalidate them either, since the ID token is never the API bearer credential (`checkRevoked` is `true` as of **AUTH-01**, §29) — a client-side credential change would **revoke nothing**,
leaving every prior session alive, including an attacker's. **This is a requirement, not an
enhancement:** native recovery may not ship before a bridge exists.

The proposed bridge is **`POST /api/auth/credentials-changed`** — authenticated, no permission,
`{ idToken }` only, with a validator that returns no field capable of carrying a client-supplied
`userId`, `businessId`, `firebaseUid` or `role`. It must satisfy three conditions before it writes
anything: the verified uid must equal the account's existing `firebaseUid`; the signed `auth_time`
must be inside the existing 300-second freshness window, failing closed when the claim is absent; and
the caller must already hold a live Inventory AI session. It then stamps `passwordChangedAt` and
revokes every session, and the client **re-exchanges afterwards** — the exchange route is public, so
the revocation cannot block it, and a token minted after the stamp is never caught by the comparison.
The bridge writes only those two things and can never move a tenant, change a role or change a status.
Full design, including its ordering, its non-retryability and the documented
`401 SESSION_INVALIDATED`-is-success rule: design §14C.3.

**The password-*reset* path — where the caller begins with no session at all — is now RESOLVED (D2).**
The bridge requires a live Inventory AI session, but `forgot-password` and `reset-password` are
**public** screens and the reset completes entirely inside Firebase, so at the moment the password
actually changes the caller holds **no** session and could not reach the bridge — which would have left
a Firebase-native reset revoking **nothing**. The approved sequence **establishes the context first**:
after the reset the user **signs in again with the new password**, the app obtains a **fresh Firebase ID
token**, establishes a **temporary recovery-context session** through the existing **public** exchange,
calls the bridge — which revokes **every** session, including that temporary one, because
`revokeAllSessions` spares no caller — and then **re-exchanges** to mint the **final** session, valid
because it was minted after the stamp. The recovery-context session is structurally an ordinary session
— **no new session type, no new field, no "recovery" flag** — and the bridge's authentication is **not**
relaxed for this path: **no public `credentials-changed` endpoint and no Cloud Function / Admin-SDK
trigger is introduced.** `passwordChangedAt` and `revokeAllSessions()` remain the N-4 invariant, the
Firebase UID → MongoDB `User` binding remains authoritative, and a Firebase ID token is still **not**
the application's bearer credential. Design: **§14C.3.8**.

**How the client knows a sign-in is a recovery continuation is now LOCKED (OD-9, 2026-09-29).** A
**durable, non-secret recovery marker** is written to `expo-secure-store` under
`inventoryai.auth.passwordResetPending`, holding **only an account fingerprint** — never a password, an
`oobCode`, a Firebase ID token, an Inventory AI JWT, a `userId`, a `businessId`, a `role` or tenant
data. It is a **flow selector, never a credential**, and the server still derives the account
exclusively from `requireAuth → req.user.id → Mongo User → firebaseUid`; no client-supplied value can
steer which account is revoked. The marker is created with **`verifyPasswordResetCode(oobCode)`**, whose
returned email is **memory-only** — used for the automatic sign-in and the fingerprint, and **never**
as an authorization source. **Automatic recovery (F1) is approved:** verify → write marker →
`confirmPasswordReset` → sign in with the new password → **temporary** public exchange →
`credentials-changed` → revoke all → **final** exchange → apply the final session. The temporary session
is **held only in a local variable** — never persisted, never applied, never navigated with, never
placed in route parameters — and `revokeAllSessions()` revokes it together with every other active
session. The marker is created **before** the password-change operation; **cleared** after a successful
bridge acknowledgement or a `401 SESSION_INVALIDATED` (which is **success-equivalent**); **kept** on
`409 FIREBASE_REAUTHENTICATION_REQUIRED` and on transport failure; never consumed on a fingerprint
mismatch; and the legacy `?token=` recovery never creates it, because that server flow already performs
the revocation. **Two limits are recorded rather than glossed.** A reset completed on one device followed
by the **first** password sign-in on **another** is **not detectable** by this client-local marker, so
OD-9 is **not** a universal cross-device revocation guarantee; and the server-side `passwordUpdatedAt`
derivation that would close that gap (**Option E**, now **OD-10**) is **deferred as a separate owner
decision, with nothing of it introduced** — no Mongo field and no extra Admin lookup. `requireAuth`,
`passwordChangedAt`, `revokeAllSessions()`, the UID→Mongo `User` mapping, Mongo business/role authority
and the JWT/session architecture are **unchanged**, and **no new session type or session field** is
introduced. Design: **§14C.3.9** (**M-1…M-10**).

**`checkRevoked` is `true` (AUTH-01), superseding the earlier L-19 review that recommended `false`.**
The approved target architecture §9/§10 requires Firebase revocation checking, and
`services/firebase/tokenVerifier.ts` passes `checkRevoked: true`, so a Firebase-side disable/delete is
consulted at every verification (exchange, renewal and the AUTH-04 pre-session routes). Two things are
unchanged by that: MongoDB `status`, checked per request, remains the revocation authority for
*Inventory AI sessions*, and **disabling a user in Firebase still does not stop their Inventory AI
session, and will not while Firebase is not the bearer credential.** The cost is the one the review
named — a network call to Google on every verification, failing closed during a Google outage — and it
is the accepted trade-off of enforcing that boundary; the failure is classified as transient
(`FIREBASE_UNAVAILABLE` → `503` on authenticated routes), never as a credential rejection.

### What is to be retired, eventually and in separately approved steps

Legacy bcrypt login and register; the two custom password-reset routes, the reset-token model and the
**entire mail layer** (whose only production consumer is password recovery); admin-created password
accounts, which must be replaced by **invitation-based Firebase onboarding** *before* legacy login is
removed, because `users.service.create` currently writes a password hash and **no `firebaseUid`** and
would otherwise produce an account with no way in; and the Inventory-specific Firebase link/unlink
lifecycle, whose Policy B destination disappears under this direction. **No artefact on this list is
removed by this specification change**, and each removal requires the same approval discipline as any
other phase.

---

# 30. Authorization

Authorization must be server-side.

Conceptually:

```text
authenticate()
      ↓
authorize()
      ↓
business isolation
      ↓
controller/service
```

The mobile application may hide unauthorized UI elements, but this is only a UX feature.

The backend remains the authority.

## Permission Catalogue and Route Bindings

`server/src/constants/roles.ts` is the single source of truth for capabilities.
It holds the permission catalogue (`PERMISSIONS`), the grants per role
(`ROLE_PERMISSIONS`), and `hasPermission(role, permission)`. The role and the
grant are derived from the authenticated `req.user`, which is loaded from the
database — never from a client-supplied role or token claim.

Every protected endpoint binds to an **explicit** capability key through
`requirePermission(PERMISSIONS.<KEY>)`. Authentication alone is not an
authorization decision: a route that reads or writes a resource with a
corresponding capability must name that capability, so the endpoint's
authorization requirement is stated in the route declaration rather than
implied by "any authenticated member of the business".

A capability in the catalogue that no endpoint implements is declared in
`CATALOGUE_ONLY_PERMISSIONS`, beside the catalogue, with the reason it is
unimplemented. That list is **metadata for the regression guard only**: it is
not consumed by `middlewares/authorize.ts` and takes no part in any runtime
authorization decision. It exists so the catalogue cannot silently accumulate
capabilities that are granted to roles but attached to nothing. As of Phase 22
it contains:

- `business.manage` — business-level settings are reserved for OWNER; no
  business-settings endpoint exists.
- `roles.manage` — role administration is reserved for OWNER; roles are fixed in
  code, so there is nothing to administer.
- `transactions.view` — the ledger read is served by
  `GET /api/inventory/history`, which is protected by `inventory.history.view`.
  See below.

Adding an endpoint that enforces a catalogue-only capability moves it out of
that list; the guard fails until it does.

## Inventory History Authorization

`GET /api/inventory/history` is protected by `inventory.history.view`, not by
`transactions.view`. All four roles hold `inventory.history.view`, whereas only
OWNER, ADMIN and MANAGER hold `transactions.view` — so gating the route on the
latter would silently revoke STAFF's inventory-history access. The two keys are
deliberately not interchangeable, and the binding is pinned by a test.

## User Creation Hierarchy

User management is the `users.manage` capability (OWNER and ADMIN only), exposed over `/api/users`.
Who may create whom is a strict server-side rule:

| Actor | May create / assign | May not |
| --- | --- | --- |
| OWNER | ADMIN, MANAGER, STAFF | — |
| ADMIN | MANAGER, STAFF | ADMIN or OWNER |
| MANAGER | — | any user (no such capability) |
| STAFF | — | any user (no such capability) |

Additional invariants, all enforced server-side and tenant-isolated:

- **No OWNER may be created or assigned through the API.** The OWNER account is immutable.
- **No user may change their own role or status.**
- **An ADMIN may neither create, assign, nor modify another ADMIN.** Cross-ADMIN modification is an
  OWNER-only act and is refused rather than merely hidden.
- A `businessId` supplied by the client is ignored; the tenant is taken from the authenticated user.

Disabling a user takes effect immediately: it revokes login and every existing session, because the
user row is reloaded from the database on each request (§30, *Role Mutation Takes Effect Immediately*).

### Invitation-Based Onboarding (implemented 2026-10-25)

Adding a colleague uses an **invitation**, so the person who will use the account chooses its
credential and the creator never learns it:

```text
OWNER / ADMIN
      ↓
create invitation (address + role, mailed to that address)
      ↓
invitation bound to the intended business and role, 7-day lifetime
      ↓
invitee opens the link and creates a Firebase identity for THAT address
      ↓
invitee proves the address with the AUTH-04 six-digit code
      ↓
server validates the invitation against the VERIFIED identity's address
      ↓
server creates the Inventory AI user in the invited business
      ↓
businessId and role assigned SERVER-SIDE from the invitation row
      ↓
Inventory AI session created by the ordinary Firebase exchange
```

The `businessId` and `role` are assigned by the server from the invitation, never accepted from the
invitee's request — the acceptance payload carries the ID token and the invitation token and nothing
else that could steer it. **No business is created on this path**: an invited person joins the
existing tenant. The invitation is not a credential for an account: holding the token proves only that
somebody received a message, and acceptance additionally requires a verified Firebase identity whose
address equals the invited one. OWNER is not invitable (a business already has an owner, and the user
API refuses to create one), and an ADMIN may not invite an ADMIN — the same hierarchy rule as direct
creation. Because `users.email` is globally unique, an address that already owns an account cannot be
invited; such a person is refused at invite time rather than merged at acceptance.

Server: `models/invitation.model.ts` (token stored as a SHA-256 digest, never in the clear; one PENDING
row per business+address; a partial unique index), `services/invitations.service.ts` (create/list/
revoke/preview/resolve), `routes/invitations.routes.ts` (the three `users.manage` routes),
`routes/invite.routes.ts` (the public `/invite` landing page), `pages/invitationLink.ts`, and
`services/mail/templates/invitation.ts`. Invitations are removed with their address on account
deletion and with the tenant on teardown. Mobile: `app/invite.tsx` (public preview), the invited shape
of Create Account, and `app/(app)/users/invitations.tsx` (send, list, revoke) reached from Users.

## Enforcement Guard — the permission contract

`server/test/phase22-authorization-contract.test.mjs` is a database-free suite
that pins the contract above: the route→capability binding for each protected
read route (structurally, by walking the router stack; behaviourally, by invoking
the gate; and by asserting the declaration names the expected catalogue key), the
partition of the catalogue into enforced and catalogue-only, the rejection of any
permission a route references that is not in the catalogue, the fact that
`CATALOGUE_ONLY_PERMISSIONS` is never consumed by the runtime authorization path,
and that all four roles still hold every capability a route now requires.

## Route Authorization Classification

Authorization is a property of **every** route, not only of the routes that happen to be gated. Each
route reachable from `server/src/app.ts` therefore falls into exactly one declared class:

- **Permission-gated** — the route carries a capability gate as its first handler after
  `requireAuth`, and its declaration names the catalogue key. This is the default and the expectation
  for every route that reads or writes a business resource.
- **Authenticated** — `requireAuth` plus a controller, with no capability gate. Reserved for the
  caller's own account (`GET`/`PATCH`/`DELETE /api/auth/me`, `POST /api/auth/change-password`,
  `POST /api/auth/renew`, `POST /api/auth/credentials-changed`, and the session-lifecycle routes
  `POST /api/auth/logout`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id` — a user's own
  sessions are self-service, so no capability is involved). `DELETE /api/auth/me` deletes only the
  caller's account, after re-authentication; `POST /api/auth/renew` re-issues a token for the caller's
  own live session; `POST /api/auth/credentials-changed` records a credential change on the caller's
  own account and revokes its sessions. Phase 32H's `POST /api/auth/firebase/link` belongs here for
  the same reason: it attaches an identity to the caller's own account and names no other account.
  Also here are the categories/locations reads, which have no view capability in the catalogue. Each
  is listed explicitly, with its reason, so that the deferral is visible and cannot be extended by
  accident.
- **Public** — no authentication at all. The health probes must answer before a token can exist;
  login/register are how a token is obtained; the Firebase exchange/registration and pre-session
  email-verification routes are how a verified Firebase identity reaches a tenant; password recovery
  (the link routes and the AUTH-06 code routes) is how a locked-out user gets a new password; the
  invitation preview is how an invited person reads the invitation. All are rate-limited.
  `POST /api/auth/firebase/register` is the one public route that creates business data (the Business
  and OWNER row), which is why it has its own limiter; the recovery flow writes credentials and
  challenges, nothing in an existing tenant's inventory. The public HTML pages (`/privacy`, `/terms`,
  `/account-deletion`, `/invite`, `/auth/reset`) are page routes outside `/api`; they write nothing
  and are readable before any session exists.
- **Role-gated** — a gate naming roles directly rather than a capability. **There are none**, and
  adding one requires an explicit decision: a role-name gate bypasses the permission catalogue, so a
  route using it would be invisible to any scan that looks only for capability keys.

A route in no class is a defect. Declaring a route in a class it no longer belongs to is also a
defect. Nothing in this section is a route inventory: no count is fixed, so a later phase adds a
route by classifying it, never by amending a number.

`requireRole(...roles)` in `server/src/middlewares/authorize.ts` is the role-name allowlist behind
the fourth class. It is retained and tested but has **no production call site**; its inertness is
pinned by the guard rather than being removed by it.

## Client Error-Code Contract

An error `code` is part of the client-facing contract. The mobile application branches on specific
codes to produce specific messages, so a code the server renames or stops emitting silently degrades
a precise client message into a generic failure. Every code the client compares against must be a
code the server can emit. The server emits codes in three ways — the third argument of
`new ApiError(...)`, a `this.code = ...` assignment on a custom error class, and a `code:` property
written directly into a response body (the rate limiters answer without going through `ApiError`) —
and all three are in scope.

## Cross-Layer RBAC Mirror

`mobile/lib/permissions.js` mirrors the catalogue and the role grants in
`server/src/constants/roles.ts` because the UI needs to know what to show. The mirror is **not** an
authorization boundary — the backend remains the sole authority, and every request is decided
server-side. The two copies are required to agree exactly: a grant present only on the server makes
the app offer an action the server refuses, and a grant present only in the mirror makes a role never
see an action it is permitted to perform. The server matrix is authoritative, and the mirror is
updated to match it.

## Enforcement Guard — classification, mirror and error codes

`server/test/phase23-authorization-contract.test.mjs` is the database-free suite that pins the three
contracts above: the classification of every route with the exemption lists and their reasons, the
mirror's equality with the server matrix (roles, catalogue keys and values, and every role's grant
set), `requireRole`'s inertness together with its recognition by the classifier, and the absence of
any client-branched error code the server cannot emit. Its comparisons are factored into pure
functions and exercised against deliberately perturbed in-memory clones, so the guard is
demonstrably capable of failing rather than merely being green.

`server/test/phase24-runtime-authorization-matrix.test.mjs` is the DB-backed counterpart: the runtime
matrix over real routes, the four role-mutation tests, and the explicit assertion that no runtime route
is reserved to OWNER alone. Its expectations come from `hasPermission`, so it too cannot drift from the
catalogue.

## Runtime Authorization Matrix

The three contracts above are **structural**: they prove that a route *declares* a gate, not that the
shipped server *applies* it to a real request. A separate DB-backed suite pins the runtime behaviour
over real endpoints, role by role.

The matrix is **derived, never transcribed**. The tier a route belongs to is computed by asking the
shipped `hasPermission(role, permission)` who holds the route's capability, so the suite holds no
second copy of the role matrix and cannot silently disagree with `src/constants/roles.ts`; a grant
change flows straight through to the cells. The matrix resolves to three invoked tiers:

| Tier | Holders | Representative capabilities |
|---|---|---|
| A | OWNER, ADMIN | `users.manage`, `audit.view`, `categories.manage`, `locations.manage` |
| B | OWNER, ADMIN, MANAGER | `products.manage`, `suppliers.manage`, `purchase-orders.manage`, `inventory.manage`, `dashboard.view` |
| C | every role | every `*.view`, `inventory.stock-in`/`stock-out`, `inventory.history.view`, `purchase-orders.receive`, `ai.use` |

There is deliberately **no OWNER-only runtime tier**. The two OWNER-exclusive capabilities
(`business.manage`, `roles.manage`) are catalogue-only per Phase 22, so no shipped endpoint
distinguishes OWNER from ADMIN. The suite asserts that emptiness explicitly rather than leaving a hole
that would read as coverage, and no route is added to make the tier testable.

Two properties keep the matrix honest and cheap to maintain:

* **An admitted cell depends on nothing but the gate.** A permission gate is the second handler, so it
  decides before validation, lookup or provider access. An admitted cell therefore asserts only "not
  401, not 403, and not the code-less global 404" — no request body, no seeded resource, no provider
  availability, no success payload — which keeps the suite immune to unrelated validation changes. The
  distinction between the two 404 shapes is what catches a mistyped path: the global handler
  (`middlewares/notFound.ts`) answers `{error, message}` with **no `code`**, while every `ApiError` 404
  carries one.
* **Denial is asserted exactly.** A refused cell asserts HTTP 403 with `code: 'FORBIDDEN'`; an
  unauthenticated request to a gated route asserts 401 with `code: 'AUTH_REQUIRED'`, sampled per tier
  rather than repeated per route because the structural suite already proves `requireAuth` is the first
  handler on every gated route.

## Role Mutation Takes Effect Immediately

Authorization is decided per request from current database state, never from token contents. An access
token carries only `sub`, `jti` plus the standard `iat`/`exp` — no role and no `businessId` claim —
and `middlewares/authenticate.ts` reloads the user (and therefore the role and business) from the
database on every request. A hand-forged `role` claim therefore neither grants a capability nor
escalates one.

The runtime consequence is specified and tested: changing a user's role takes effect on the
**already-issued token**, with no new login. Promotion grants the new capability and demotion revokes
the old one immediately, in both directions, including across tiers. This mirrors the long-standing
account-status rule, where disabling a user revokes an existing JWT instantly.

## Tenant Isolation Mechanism

Tenant isolation is enforced by **query scoping**, not by a rejection middleware: every business-owned
read and write is filtered by the `businessId` taken from the authenticated session, so a reference to
another tenant's resource resolves to nothing and surfaces as an ordinary 404 `NOT_FOUND`. Client
supplied `businessId` values are never trusted and never influence a query.

`src/utils/businessAccess.ts` (`assertBusinessAccess`, which emits the `FORBIDDEN_BUSINESS` code) has
**no production call site** — it is referenced only by tests, one of which exercises it inside a
test-only router. It is retained unmodified, wired to nothing, and no client behaviour depends on it;
the `FORBIDDEN_BUSINESS` code is consequently not reachable at runtime in production. The presence of
that utility must not be read as the isolation mechanism.

---

# 31. API Structure

REST API modules:

```text
/api/auth
/api/businesses
/api/users
/api/locations
/api/categories
/api/products
/api/purchase-orders
/api/suppliers
/api/inventory
/api/transactions
/api/dashboard
/api/ai
/api/audit
```

Example endpoints:

```text
POST   /api/auth/register
POST   /api/auth/login

GET    /api/users
POST   /api/users
GET    /api/users/:id
PATCH  /api/users/:id

GET    /api/products
POST   /api/products
GET    /api/products/:id
PATCH  /api/products/:id
POST   /api/products/:id/archive
POST   /api/products/:id/restore

GET    /api/suppliers
POST   /api/suppliers
GET    /api/suppliers/:id
PATCH  /api/suppliers/:id
POST   /api/suppliers/:id/archive
POST   /api/suppliers/:id/restore

POST   /api/purchase-orders
GET    /api/purchase-orders
GET    /api/purchase-orders/:id
PATCH  /api/purchase-orders/:id
POST   /api/purchase-orders/:id/issue
POST   /api/purchase-orders/:id/cancel
POST   /api/purchase-orders/:id/receive

GET    /api/inventory
POST   /api/inventory/stock-in
POST   /api/inventory/stock-out

GET    /api/transactions

GET    /api/dashboard

POST   /api/ai/chat
GET    /api/ai/conversations
GET    /api/ai/conversations/:id

GET    /api/audit
```

Exact endpoint design may be refined during implementation while preserving the architecture and security requirements.

These are illustrative examples, not an exhaustive or guaranteed contract. The implemented product surface is archive/restore: product deletion is not implemented and is not part of the contract (see §13 Product Lifecycle). There is likewise no `/api/transactions` module — the ledger is read through `GET /api/inventory/history`, protected by `inventory.history.view` (see §30 Inventory History Authorization).

---

# 32. API Validation

Every write endpoint must validate input.

Validation must include:

- Required fields
- Data types
- String lengths
- Numeric ranges
- IDs
- Enum values
- Business ownership
- Permissions

Invalid requests must return appropriate HTTP status codes and structured errors.

---

# 33. Error Handling

The backend should use centralized error handling.

Errors should be:

- Consistent
- Safe
- Useful to clients
- Free of sensitive internal details

Production responses must not expose:

- Stack traces
- Database credentials
- Internal paths
- Secrets
- Provider credentials

---

# 34. Security Requirements

Production backend must include appropriate protection such as:

- HTTPS
- JWT authentication
- bcrypt password hashing
- Server-side authorization
- Request validation
- Rate limiting
- CORS configuration
- Secure environment variables
- MongoDB least-privilege credentials
- Safe error responses
- Business data isolation
- AI request limits

Never commit secrets to Git.

---

# 35. Environment Configuration

Use environment variables.

Example:

```text
NODE_ENV
PORT
MONGODB_URI
JWT_SECRET
JWT_EXPIRES_IN
JWT_ISSUER
JWT_AUDIENCE
JWT_REFRESH_SECRET
AI_PROVIDER
OPENROUTER_API_KEY
OPENROUTER_BASE_URL
AI_MODEL_OPENROUTER
```

## Firebase Configuration

Firebase credentials are **server-side only** and are never sent to the mobile application. Either
the three separate values:

```text
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
```

or a single base64-encoded service-account document, which is preferred because it removes the
newline-mangling failure class entirely:

```text
FIREBASE_SERVICE_ACCOUNT_JSON
```

Production fails fast in the existing `validateProductionConfig` contract: if any Firebase variable is
set, all required ones must be present and the key must parse. The error names only the **variable**,
never its value. In development and test these checks stay lenient, so the server still boots without
Firebase configured — and while Firebase is unconfigured the Firebase routes answer their own
not-configured error rather than the server failing to start.

`server/.env.example` carries these **names with comments and no values**. No credential, service
account document or private key is ever committed, logged, or returned in a response.

The mobile application holds **no** Firebase secret. Under the M2 integration path it uses only the
public `EXPO_PUBLIC_FIREBASE_*` client configuration (apiKey, authDomain, projectId, appId), which is
not a credential and cannot authorize anything by itself: the API accepts Inventory AI tokens only.

## Password Recovery and Mail Delivery

Mail delivery is shared by email verification and both password-recovery paths. It requires:

```text
MAIL_PROVIDER               the provider that sends mail; empty disables all mail
MAIL_FROM                   a sender address the provider has verified
BREVO_API_KEY               provider credential — server-side only
MAIL_APP_NAME               optional; product name shown in the email (default "Inventory AI")
MAIL_REQUEST_TIMEOUT_MS     optional; abort a provider request slower than this (default 10000)
PASSWORD_RESET_URL          only the emailed-link path; not used by the AUTH-06 code flow
EMAIL_VERIFICATION_CODE_PEPPER  keys the verification and reset-code digests
```

The provider and its credential must be set before any verification or reset mail is sent. The
emailed-link path also requires `PASSWORD_RESET_URL`; while any of the three is missing,
`POST /api/auth/forgot-password` answers its fixed `503` and no token is written. The AUTH-06 code flow
requires the provider and the pepper, but **not** `PASSWORD_RESET_URL`; the code route
`POST /api/auth/password-reset/code` answers `503 PASSWORD_RESET_CODE_NOT_CONFIGURED` before any account
lookup when either is unusable. A provider credential is never returned in a response, written to a
log, or sent to the mobile application.

For the emailed-link path, `PASSWORD_RESET_URL` is the **only** source of the reset URL. It is never
built from the `Host`, `Origin` or `Referer` headers or from anything a client sends, so a hostile
request cannot redirect a victim's reset link to another domain. It must point at a real screen that
reads the token from its query string and submits it to `POST /api/auth/reset-password`; a value
pointing nowhere leaves that path configured but unusable. The code flow never builds a URL.

Recovery is rate-limited per source address and per account, separately from login. The AUTH-06
`/password-reset/code` route uses the request budgets below; `/password-reset/verify` and
`/password-reset/confirm` share the confirm budget:

```text
AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS          default 3600000  (1 hour)
AUTH_PASSWORD_RESET_RATE_LIMIT_MAX                default 5        per source + email
AUTH_PASSWORD_RESET_IP_RATE_LIMIT_WINDOW_MS       default 3600000  (1 hour)
AUTH_PASSWORD_RESET_IP_RATE_LIMIT_MAX             default 20       per source
AUTH_PASSWORD_RESET_CONFIRM_RATE_LIMIT_WINDOW_MS  default 900000   (15 minutes)
AUTH_PASSWORD_RESET_CONFIRM_RATE_LIMIT_MAX        default 20       reset attempts per source
```

Every attempt counts against these budgets, including successful ones and requests for addresses that
have no account (§29 Password Recovery). The rate-limit values are read when the server builds its
routes, so **changing any of them requires a restart**; the mail values above are read per request and
take effect without one. Limit budgets are held in process memory, so a deployment with more than one
application instance multiplies each of them.

Secrets must never be hardcoded.

Provide:

```text
.env.example
```

without real credentials.

---

# 36. Database Indexing

Appropriate indexes should be created for common queries.

Potential indexes:

```text
businessId
businessId + sku
businessId + barcode
businessId + name
businessId + productId
businessId + locationId
businessId + productId + locationId
businessId + createdAt
```

Indexes must be based on actual query patterns and should not be created indiscriminately.

---

# 37. Performance Requirements

Backend:

- Use pagination.
- Avoid unnecessary database queries.
- Use indexes.
- Return only required fields where appropriate.
- Avoid unbounded queries.

Mobile:

- Optimize list rendering.
- Use pagination/infinite loading where appropriate.
- Debounce search.
- Avoid unnecessary re-renders.
- Optimize image loading.
- Keep API payloads reasonable.

AI:

- Do not send the entire database to the model.
- Retrieve only relevant records through tools.
- Keep prompts/context controlled.
- Limit conversation history when appropriate.
- Track AI usage where possible.

---

# 38. Offline Strategy

V1 will be:

```text
ONLINE-FIRST
```

The application should not attempt full offline synchronization during initial development.

However, architecture should avoid making future offline support impossible.

Future implementation may include:

```text
Local Cache
↓
Offline Queue
↓
Synchronization
↓
Conflict Resolution
↓
Server
```

Offline inventory writes should only be introduced after a clear synchronization strategy is designed.

---

# 39. Barcode / QR Strategy

V1 product schema should include:

```text
barcode
```

Scanning **shipped during V1**, so the pipeline this section originally deferred is the one that exists:

```text
Camera
 ↓
Barcode Scanner
 ↓
Product Lookup
 ↓
Inventory Action
```

The camera reads a barcode, the app resolves it through the authenticated, business-scoped lookup and
shows the product with its per-location stock; an `ACTIVE` product offers **Stock In / Stock Out** with
that product pre-selected, and the product screen can be opened from the result. A product whose code is
thirteen digits prints and shares an **EAN-13** label.

A code the application generates is a valid EAN-13 — thirteen digits in the GS1 "restricted distribution"
range (prefix `2`), with a computed check digit — and is unique within its business. Uniqueness applies
only to products that carry a code; products without one are outside that index.

---

# 40. Product Images

Product images should not be stored directly inside MongoDB documents as large binary data for normal usage.

Preferred architecture:

```text
Mobile
 ↓
Image Storage
 ↓
Image URL
 ↓
MongoDB
```

The specific image storage provider can be selected later.

---

# 41–55. Retired planning sections

These fifteen sections were the original build plan: generic testing lists, branch strategy, proposed
document types, V1 screen and flow sketches, a scope summary, the V2–V4 wish list, cost control,
deployment and store boilerplate, observability, backup, acceptance criteria and the phase sequence.
They were removed on 2026-11-06 because they described intentions rather than the system that exists,
and several contradicted it: §47 excluded the barcode scanner that §39 records as shipped, §43
proposed specification files that do not exist, and §49 listed AI cost controls as future work after
they had shipped.

| Question | Read |
| --- | --- |
| What must the system do? | the sections above this one |
| How is it verified? | `server/test/` and the checks in `.github/workflows/ci.yml` |
| How do I run, test or release it? | `docs/guides/` |
| What shipped, with evidence? | `docs/DEVELOPMENT_ROADMAP.md` |
| What is planned next? | `docs/DEVELOPMENT_LOG.md` |

Dated records that cite §44 or §48 refer to this retired text, not to a current section. The two
principles that still bind are §56 (the specification is the source of truth) and §57 (the backend,
not the AI, owns business rules, permissions and inventory consistency).

# 56. Source of Truth Rule

When implementation decisions conflict with this specification:

1. Review the specification.
2. Identify the conflict.
3. Do not silently change architectural requirements.
4. Report significant conflicts before making major changes.
5. Update the specification only when the project decision intentionally changes.

The goal is to prevent implementation drift as the project becomes larger.

---

# 57. Final Architecture Principle

The system should maintain this separation:

```text
MOBILE
User Interface
        ↓
BACKEND
Security + Business Logic
        ↓
DATABASE
Source of Truth

AI
Natural Language Interface
        ↓
Controlled Backend Tools
        ↓
Authorized Database Information
```

The AI is an assistant.

It is not the database.

It is not the authorization layer.

It is not the inventory engine.

The backend remains the authority for business rules, permissions, and inventory consistency.