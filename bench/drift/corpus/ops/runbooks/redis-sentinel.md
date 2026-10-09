# Runbook: Redis Sentinel

Beacon uses Redis for rate limiting, alert de-duplication and short-lived locks. Nothing in Redis is durable: if we lose
it, rate limits reset and a few alerts may be sent twice. That is annoying, not catastrophic.

## Setup

Each production region runs three Redis nodes (one primary, two replicas) and three Sentinel processes that watch them
and promote a replica when the primary fails. Clients connect to Sentinel first to find out which node is the primary.

| Component | Port | Hosts |
| --- | --- | --- |
| Redis | 6379 | `redis-{1,2,3}.cache.euc1.nwl.internal` |
| Sentinel | 26379 | Same hosts, separate process |

The master group name is `beacon`. Quorum is 2.

## Checking health

```bash
redis-cli -h redis-1.cache.euc1.nwl.internal -p 26379 sentinel get-master-addr-by-name beacon
redis-cli -h redis-1.cache.euc1.nwl.internal -p 26379 sentinel replicas beacon
```

All three Sentinels should agree on the primary. If they do not, one of them is partitioned; restart it.

## Failover

Sentinel fails over on its own after the primary has been unreachable for 10 seconds. To fail over by hand (before
patching the primary, for example):

```bash
redis-cli -h redis-1.cache.euc1.nwl.internal -p 26379 sentinel failover beacon
```

Services reconnect within a few seconds. Expect a short burst of `READONLY` errors in the logs.

## Memory pressure

Redis is configured with `maxmemory 6gb` and the `volatile-lru` policy. Every key we write has a TTL, so Redis evicts
old de-duplication keys first. If memory stays above 90%, look for keys without a TTL:

```bash
redis-cli -h <primary> --scan --pattern 'dedupe:*' | head
```

## Known issues

- Sentinel can promote a replica that is far behind if the primary flaps. We accept that; nothing in Redis is precious.
- After a full region restart, start the Redis nodes before the Sentinels, or the Sentinels elect nothing.

## Escalation

Redis belongs to the Platform team. During an incident, page Platform on-call if a failover does not complete within a
minute.
