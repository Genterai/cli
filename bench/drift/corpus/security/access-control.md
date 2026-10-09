# Access control

Who gets access to what, how they get it, and how we take it away again. The principle is least privilege with as little
friction as we can manage: short-lived credentials, granted through one identity, reviewed regularly.

## Identity

Everyone has one identity: their Google Workspace account. Every tool that supports SAML or OIDC signs in with it. Tools
that do not support SSO are listed in the "Non-SSO tools" sheet with an owner, and their passwords live in 1Password.

- Multi-factor authentication is required for every account.
- Hardware security keys are required for engineers and for anyone with admin rights in any tool.
- Shared accounts are not allowed, except for the few service accounts registered with Security.

## AWS

Nobody has long-lived AWS keys. Engineers get short-lived credentials through **IAM Identity Center**, which is connected
to Google Workspace groups.

| Permission set | Who | What |
| --- | --- | --- |
| `ReadOnly` | All engineers | Read access to every account |
| `Developer` | Engineers on their own team's accounts | Deploy, read logs, manage non-production resources |
| `ProdOperator` | Platform team and on-call | Change production resources, restart nodes |
| `BreakGlass` | Head of Platform, CTO | Full admin; every use pages Security |

Sessions last at most 8 hours. Use `aws sso login` and the profiles that bootstrap writes to your AWS config.

## Kubernetes and databases

Cluster access is mapped from the AWS permission sets: `ReadOnly` becomes a read-only Kubernetes role, `ProdOperator`
can exec into pods. Database access goes through the `nwctl db shell` tunnel and needs the matching role; see
[Database](../ops/database.md).

## Laptops

- Disk encryption (FileVault) is on and enforced by device management.
- The screen locks after **5 minutes of inactivity** and needs your password or Touch ID to unlock.
- Automatic OS updates are on; device management nags after seven days and blocks access to Google after fourteen.
- No local admin rights by default. Ask in #it-help with a reason if you need them.

## Access reviews

Every quarter, managers review the access of their reports in each critical system (AWS, GitHub, Google admin, Stripe,
the CRM), and Security removes anything that is not confirmed within two weeks.

## Joiners and leavers

- Joiners get the access of their role template on day one; anything extra needs a request in #it-help with the
  manager's approval.
- Leavers lose access on their last working day by the end of the day. Disabling the Google account removes SSO access
  everywhere at once; IT then checks the non-SSO tools.
- Role changes: the old access is removed when the new access is granted, not later.

## Production data

Customer data in production is accessed only to operate the service or to help a customer who asked for it. Access is
logged. Copying production data to laptops, staging or third-party tools is not allowed.
