# Usage events

Optional counts that answer "does mail flow, and do people get through sign-in?" without reading logs or mail.

## What is counted
One Workers Analytics Engine data point for each web request and each inbound message. The dataset lives in your own Cloudflare account. Nothing is sent to the Stanchion project or anyone else.

| Source | Name | Outcome | Status class | Numbers |
|---|---|---|---|---|
| Web app, each page or API request that reaches the server (not static files, not internal sub-requests) | the route template, such as `/mail/[id]` (`other` if none) | `ok`; `client` for a 4xx (signed-out visitors, not found); `error` for a 5xx or a thrown error | `2xx` to `5xx` | milliseconds |
| Inbound mail, every message | `mail.inbound` | `handled` (not rejected: stored, held, dropped, a duplicate, or a journal report), `error` (the handler threw), or a reject code | `2xx` or `5xx` (a reject counts as 5xx) | milliseconds, message bytes, a count of 1 |

Reject codes: `invalid_address`, `size_limit`, `unknown_recipient`, `metadata_limit`, `cannot_accept`, `unparseable`, `attachment_count`, `attachment_size`, `attachment_type`, `recipient_limit`, `journal_refused`, `rejected_other` (a reject text we do not recognise).

## What is never counted
Addresses, subjects, message or attachment content, file names, user or session ids, IP addresses, domain or organisation names, free text, query strings and headers. There is no organisation or user pseudonym either.

## Turn it on
Uncomment the `analytics_engine_datasets` block in `apps/web/wrangler.toml` and `apps/email-worker/wrangler.toml` (both may use the same dataset name), then deploy. With no binding the code does nothing.

## Example query
Inbound mail by outcome over the last day (Analytics Engine SQL API):

```sql
SELECT blob2 AS outcome, SUM(_sample_interval) AS messages
FROM stanchion_usage
WHERE blob1 = 'mail.inbound' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY outcome
ORDER BY messages DESC
```

Untested until the first data point lands in your account.
