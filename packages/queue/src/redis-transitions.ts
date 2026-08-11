import type { Redis } from 'ioredis';
import type { QueueJobState } from './state-machine.js';
import type { RedisQueueKeys } from './redis-keys.js';

const COMPARE_AND_EXTEND = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local sep = string.find(cur, '\\n', 1, true)
local curToken = sep and string.sub(cur, 1, sep - 1) or cur
if curToken == ARGV[1] then
  local extended = redis.call('EXPIRE', KEYS[1], ARGV[2])
  if extended == 1 then
    local tenant = redis.call('HGET', KEYS[3], ARGV[1])
    if tenant then redis.call('ZADD', KEYS[4], tonumber(ARGV[3]) + tonumber(ARGV[2]) * 1000, ARGV[1]) end
  end
  return extended
end
return 0`;

const MARK_RUNNING = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local sep = string.find(cur, '\\n', 1, true)
local curToken = sep and string.sub(cur, 1, sep - 1) or cur
if curToken ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], 'running', 'EX', ARGV[2])
return 1`;

const FINALIZE_OWNED_CLAIM = `
local function releaseTenantClaim()
  local tenant = redis.call('HGET', KEYS[#KEYS - 1], ARGV[1])
  if tenant then
    local remaining = redis.call('HINCRBY', KEYS[#KEYS - 2], tenant, -1)
    if remaining <= 0 then redis.call('HDEL', KEYS[#KEYS - 2], tenant) end
    redis.call('HDEL', KEYS[#KEYS - 1], ARGV[1])
  end
  redis.call('ZREM', KEYS[#KEYS], ARGV[1])
end
local cur = redis.call('GET', KEYS[1])
local curToken = nil
if cur then
  local sep = string.find(cur, '\\n', 1, true)
  curToken = sep and string.sub(cur, 1, sep - 1) or cur
end
if not curToken or curToken ~= ARGV[1] then
  releaseTenantClaim()
  redis.call('LREM', KEYS[2], 1, ARGV[2])
  redis.call('DEL', KEYS[3])
  return 0
end
for i = 6, #KEYS - 3 do
  redis.call('SET', KEYS[i], '1', 'EX', ARGV[4])
end
redis.call('SET', KEYS[5], ARGV[5], 'EX', ARGV[4])
releaseTenantClaim()
redis.call('DEL', KEYS[1])
redis.call('LREM', KEYS[2], 1, ARGV[2])
redis.call('DEL', KEYS[3])
if ARGV[3] == '1' then redis.call('DEL', KEYS[4]) end
return 1`;

const DEAD_LETTER_OWNED_CLAIM = `
local function releaseTenantClaim()
  local tenant = redis.call('HGET', KEYS[#KEYS - 1], ARGV[1])
  if tenant then
    local remaining = redis.call('HINCRBY', KEYS[#KEYS - 2], tenant, -1)
    if remaining <= 0 then redis.call('HDEL', KEYS[#KEYS - 2], tenant) end
    redis.call('HDEL', KEYS[#KEYS - 1], ARGV[1])
  end
  redis.call('ZREM', KEYS[#KEYS], ARGV[1])
end
local cur = redis.call('GET', KEYS[1])
local curToken = nil
if cur then
  local sep = string.find(cur, '\\n', 1, true)
  curToken = sep and string.sub(cur, 1, sep - 1) or cur
end
if not curToken or curToken ~= ARGV[1] then
  releaseTenantClaim()
  redis.call('LREM', KEYS[2], 1, ARGV[2])
  redis.call('DEL', KEYS[3])
  return 0
end
redis.call('LPUSH', KEYS[6], ARGV[3])
redis.call('LTRIM', KEYS[6], 0, 9999)
redis.call('SET', KEYS[5], 'dead-lettered', 'EX', ARGV[4])
releaseTenantClaim()
redis.call('DEL', KEYS[1])
redis.call('LREM', KEYS[2], 1, ARGV[2])
redis.call('DEL', KEYS[3])
redis.call('DEL', KEYS[4])
return 1`;

const REPLACE_CLAIM_PAYLOAD = `
local cur = redis.call('GET', KEYS[2])
if not cur then return 0 end
local sep = string.find(cur, '\\n', 1, true)
local curToken = sep and string.sub(cur, 1, sep - 1) or cur
if curToken ~= ARGV[1] then return 0 end
local removed = redis.call('LREM', KEYS[1], 1, ARGV[2])
if removed == 0 then return 0 end
redis.call('RPUSH', KEYS[1], ARGV[3])
local ttl = redis.call('TTL', KEYS[2])
if ttl ~= false and ttl > 0 then
  redis.call('SET', KEYS[2], ARGV[4], 'EX', ttl)
else
  redis.call('SET', KEYS[2], ARGV[4], 'EX', tonumber(ARGV[5]))
end
return 1`;

const DECREMENT_AT_MOST = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 0 then return 0 end
return redis.call('DECRBY', KEYS[1], math.min(current, tonumber(ARGV[1])))`;

const RELEASE_TENANT_CLAIM = `
local tenant = redis.call('HGET', KEYS[2], ARGV[1])
if tenant then
  local remaining = redis.call('HINCRBY', KEYS[1], tenant, -1)
  if remaining <= 0 then redis.call('HDEL', KEYS[1], tenant) end
  redis.call('HDEL', KEYS[2], ARGV[1])
end
return redis.call('ZREM', KEYS[3], ARGV[1])`;

type TenantLeaseKeys = Pick<RedisQueueKeys, 'tenantActive' | 'tenantClaims' | 'tenantClaimExpiry'>;

export interface FinalizeClaimInput {
  inflightKey: string;
  processingKey: string;
  processingMetaKey: string;
  seenKey: string;
  stateKey: string;
  doneKeys: readonly string[];
  token: string;
  processingEntry: string;
  deleteSeen: boolean;
  state: Extract<QueueJobState, 'succeeded' | 'failed'>;
  stateTtlSeconds: number;
  tenantLeaseKeys: TenantLeaseKeys;
}

export interface DeadLetterClaimInput {
  inflightKey: string;
  processingKey: string;
  processingMetaKey: string;
  seenKey: string;
  stateKey: string;
  deadLettersKey: string;
  token: string;
  processingEntry: string;
  record: string;
  stateTtlSeconds: number;
  tenantLeaseKeys: TenantLeaseKeys;
}

/**
 * Private transition repository. Every method maps one application transition
 * to one Redis transaction; queue orchestration never reaches into Lua/key
 * details while enforcing ownership or terminal states.
 */
export class RedisQueueTransitionRepository {
  constructor(private readonly redis: Redis) {}

  async renewLease(
    inflightKey: string,
    token: string,
    ttlSeconds: number,
    tenantLeaseKeys: TenantLeaseKeys,
  ): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          COMPARE_AND_EXTEND,
          4,
          inflightKey,
          tenantLeaseKeys.tenantActive,
          tenantLeaseKeys.tenantClaims,
          tenantLeaseKeys.tenantClaimExpiry,
          token,
          ttlSeconds,
          Date.now(),
        ),
      ) === 1
    );
  }

  async markRunning(
    inflightKey: string,
    stateKey: string,
    token: string,
    stateTtlSeconds: number,
  ): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(MARK_RUNNING, 2, inflightKey, stateKey, token, stateTtlSeconds),
      ) === 1
    );
  }

  async finalizeOwnedClaim(input: FinalizeClaimInput): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          FINALIZE_OWNED_CLAIM,
          8 + input.doneKeys.length,
          input.inflightKey,
          input.processingKey,
          input.processingMetaKey,
          input.seenKey,
          input.stateKey,
          ...input.doneKeys,
          input.tenantLeaseKeys.tenantActive,
          input.tenantLeaseKeys.tenantClaims,
          input.tenantLeaseKeys.tenantClaimExpiry,
          input.token,
          input.processingEntry,
          input.deleteSeen ? '1' : '0',
          input.stateTtlSeconds,
          input.state,
        ),
      ) === 1
    );
  }

  async deadLetterOwnedClaim(input: DeadLetterClaimInput): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          DEAD_LETTER_OWNED_CLAIM,
          9,
          input.inflightKey,
          input.processingKey,
          input.processingMetaKey,
          input.seenKey,
          input.stateKey,
          input.deadLettersKey,
          input.tenantLeaseKeys.tenantActive,
          input.tenantLeaseKeys.tenantClaims,
          input.tenantLeaseKeys.tenantClaimExpiry,
          input.token,
          input.processingEntry,
          input.record,
          input.stateTtlSeconds,
        ),
      ) === 1
    );
  }

  async replaceClaimPayload(input: {
    processingKey: string;
    inflightKey: string;
    token: string;
    oldEntry: string;
    newEntry: string;
    leaseTtlSeconds: number;
  }): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          REPLACE_CLAIM_PAYLOAD,
          2,
          input.processingKey,
          input.inflightKey,
          input.token,
          input.oldEntry,
          input.newEntry,
          input.newEntry,
          input.leaseTtlSeconds,
        ),
      ) === 1
    );
  }

  async decrementAtMost(key: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    await this.redis.eval(DECREMENT_AT_MOST, 1, key, amount);
  }

  async releaseTenantClaim(tenantLeaseKeys: TenantLeaseKeys, token: string): Promise<void> {
    if (!token) return;
    await this.redis.eval(
      RELEASE_TENANT_CLAIM,
      3,
      tenantLeaseKeys.tenantActive,
      tenantLeaseKeys.tenantClaims,
      tenantLeaseKeys.tenantClaimExpiry,
      token,
    );
  }
}
