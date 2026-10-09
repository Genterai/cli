# API guidelines

Rules for the public Beacon REST API. Customers build integrations on top of it (Terraform provider, scripts, internal
dashboards), so consistency matters more than local elegance. When in doubt, look at how `/v2/monitors` does it.

## Basics

- JSON in, JSON out. Field names in `snake_case`.
- Base URL: `https://api.getbeacon.io/v2/`. The major version is in the path.
- Authentication with a bearer token: `Authorization: Bearer <token>`. Tokens are created in the dashboard and scoped to
  one workspace.
- Timestamps are RFC 3339 strings in UTC (`2026-08-14T09:30:00Z`).
- IDs are opaque strings with a type prefix: `mon_`, `ale_`, `inc_`, `chn_`.

## Resources

| Resource | Path | Notes |
| --- | --- | --- |
| Monitors | `/v2/monitors` | Create, update, pause, delete |
| Results | `/v2/monitors/{id}/results` | Read only, newest first |
| Incidents | `/v2/incidents` | Read only; created by the system |
| Alert channels | `/v2/channels` | Email, Slack, webhook, ... |
| Status pages | `/v2/status-pages` | Includes components and announcements |

## Pagination

All list endpoints use cursor pagination. Offsets are not supported, because results change too quickly for offsets to
be stable.

- Request: `?limit=50&cursor=<opaque>`. The default `limit` is 50, the maximum is 200.
- Response: the items are in `data`, and the cursor for the next page is in `next_cursor`. When there are no more
  pages, it is `null`.

```json
{
  "data": [{ "id": "mon_8f2k1", "name": "Checkout API" }],
  "next_cursor": "eyJpZCI6Im1vbl84ZjJrMSJ9"
}
```

## Errors

Errors use the problem-details format (RFC 9457) with an extra `code` field that clients can switch on:

```json
{ "type": "https://docs.getbeacon.io/errors/validation", "title": "Invalid interval",
  "status": 422, "code": "interval_too_short", "detail": "Minimum interval on your plan is 60 seconds." }
```

Never return a 500 for a client mistake. Never put stack traces in responses.

## Rate limits

Each API token may make up to **600 requests per minute**. Every response carries `X-RateLimit-Limit`,
`X-RateLimit-Remaining` and `X-RateLimit-Reset`. Over the limit, the API returns `429` with a `Retry-After` header.
Enterprise customers can ask for a higher limit through their account manager.

## Idempotency

`POST` endpoints accept an `Idempotency-Key` header. A repeated request with the same key within 24 hours returns the
original response instead of creating a duplicate. The Terraform provider always sends one.

## Changing the API

- Adding a field or an endpoint is not a breaking change; ship it behind the normal review.
- Removing or renaming anything, or changing a type, is breaking. It needs a new major version or a deprecation period.
- Deprecations are announced on the changelog and through the `Deprecation` and `Sunset` response headers, at least six
  months before removal.
- Every change updates the OpenAPI file in `api/openapi.yaml`; CI fails when the spec and the handlers disagree.
