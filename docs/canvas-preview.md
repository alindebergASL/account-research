# Canvas preview gating

The read-only dynamic canvas view (`web/components/canvas/ReadOnlyCanvasView`)
is gated by a **server-side capability**. It is off in production by
default and only available to admins when explicitly enabled.

## How it's gated

Two conditions must both hold for any user to see the canvas preview:

1. `CANVAS_PREVIEW_ENABLED=1` is set in the **server** environment
   (not `NEXT_PUBLIC_*`; this is a real server-side env var so the
   value never inlines into the client bundle).
2. The authenticated user has `role === "admin"`.

If either is missing, `web/app/brief/[id]/page.tsx` renders exactly as
before — no toggle, no canvas view, no extra UI surface.

The decision lives in `web/lib/canvas/capability.ts#canPreviewCanvas`
and is computed server-side inside `GET /api/briefs/[id]`. The brief
page consumes a single boolean field `canvas_preview` from that
response. No client-side env var, no role string, no secrets are
shipped to the browser.

## Public share routes

`web/app/s/[token]` and `web/app/api/share/[token]/...` are **always
excluded** from canvas preview, regardless of the env var. They do not
have an authenticated user; the capability helper returns `false` for
anonymous callers.

## Production enablement

By default this PR ships with the env var **absent**, which means:

- Production stays dark for everyone.
- Admins do not see the toggle.
- Non-admins do not see the toggle.

To enable preview for admins in lab/staging/production, add to
`web/.env.local` on the server (and rebuild + reload PM2 so the
Next.js process picks it up):

```
CANVAS_PREVIEW_ENABLED=1
```

`NEXT_PUBLIC_*` is **not** the production gate. The previous
client-only `NEXT_PUBLIC_ENABLE_CANVAS_BRIDGE` flag has been removed
from the codebase to avoid confusion.

## What the preview shows

Read-only only. The canvas widgets:

- Are derived from the saved Brief; no model calls, no DB writes.
- Ship `controls: { can_refresh: false, can_remove: false, can_edit: false, can_export: false }`.
- Cannot mutate the brief, schedule refreshes, or call any API.

This PR adds **no DB migration** and changes no schema. Existing
brief, share, export, refresh, version-history, and worker behaviour
is preserved.
