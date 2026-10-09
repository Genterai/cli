# Data retention

How long we keep each kind of data, and what happens when the time is up. These periods are part of our data processing
agreement with customers, so do not change them without Legal and Security.

## Customer data

| Data | Kept for | Then |
| --- | --- | --- |
| Raw check results (one row per check run per location) | 400 days | Partition dropped in ClickHouse |
| Hourly and daily aggregates (uptime %, response times) | 25 months | Deleted |
| Incidents and alert history | 3 years | Deleted |
| Monitor definitions and alert rules | While the account exists | Deleted with the account |
| Status page subscribers (email addresses) | Until they unsubscribe | Deleted within 7 days |
| Webhook payloads we sent | 30 days | Deleted |

The dashboard shows less history than we store, depending on the plan (see [Pricing](../product/pricing.md)). Upgrading
makes older history visible again, as long as it is still within the period above.

## When a customer leaves

1. Cancelling a subscription moves the workspace to the Free plan; nothing is deleted.
2. Deleting a workspace starts a 30-day grace period in which the owner can restore it.
3. After the grace period, a job deletes the workspace's rows in Postgres and ClickHouse and its files in S3.
4. Data in backups ages out with the backup retention (see [Backups](../ops/backups.md)); we do not edit backups.

Customers can ask for earlier deletion through Support. Security handles those requests within ten days and confirms in
writing.

## Our own data

| Data | Kept for |
| --- | --- |
| Application logs (Loki) | 14 days |
| Audit logs of staff access to production | 2 years |
| Cloud audit logs (CloudTrail) | 1 year, then archived for 6 more |
| Support tickets | 3 years after the last reply |
| Sales records of customers who never bought | 2 years after the last contact |

## Personal data in logs

Logs must not contain personal data beyond IDs. If you find email addresses, IP addresses of end users or response
bodies in logs, open a Security issue and fix the logging; the 14-day retention is a safety net, not a permission.

## Legal holds

When Legal places a hold (a dispute, an investigation), the affected data is copied to a separate bucket with Object
Lock and kept until Legal releases the hold, regardless of the periods above.

## Reviews

Security and Legal review this page once a year, and whenever we add a new kind of data or a new sub-processor.
