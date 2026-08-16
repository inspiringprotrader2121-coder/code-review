import { DEQUEUE_INSPECTION_WINDOW } from './types.js';

/**
 * Redis Lua programs used by the queue. Keeping all multi-key state changes
 * here makes their atomicity reviewable independently from queue orchestration.
 */
export { DEQUEUE_INSPECTION_WINDOW };
export const RELEASE_RECOVERY_LEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export const RECOVER_PROCESSING_LUA = `
local function releaseTenantClaim()
  local tenant = redis.call('HGET', KEYS[12], ARGV[5])
  if tenant then
    local remaining = redis.call('HINCRBY', KEYS[11], tenant, -1)
    if remaining <= 0 then redis.call('HDEL', KEYS[11], tenant) end
    redis.call('HDEL', KEYS[12], ARGV[5])
  end
  redis.call('ZREM', KEYS[13], ARGV[5])
end
local cur = redis.call('GET', KEYS[3])
if cur then
  if ARGV[5] == '' then return 'live' end
  local sep = string.find(cur, '\\n', 1, true)
  local curToken = sep and string.sub(cur, 1, sep - 1) or cur
  if curToken == ARGV[5] then return 'live' end
  local removed = redis.call('LREM', KEYS[1], 1, ARGV[1])
  if removed == 0 then return 'claimed-by-peer' end
  releaseTenantClaim()
  redis.call('DEL', KEYS[2])
  return 'superseded'
end
local started = tonumber(redis.call('GET', KEYS[2]) or '')
if not started then
  redis.call('SET', KEYS[2], ARGV[2], 'EX', 3600, 'NX')
  return 'grace'
end
if tonumber(ARGV[2]) - started < tonumber(ARGV[3]) then return 'grace' end
local removed = redis.call('LREM', KEYS[1], 1, ARGV[1])
if removed == 0 then return 'claimed-by-peer' end
releaseTenantClaim()
redis.call('DEL', KEYS[2])
if redis.call('EXISTS', KEYS[4]) == 1 or redis.call('EXISTS', KEYS[5]) == 1 then
  return 'done'
end
local resumes = redis.call('INCR', KEYS[6])
redis.call('EXPIRE', KEYS[6], 86400)
if resumes > tonumber(ARGV[4]) then
  local dead = cjson.encode({ id = ARGV[8], job = ARGV[6], reason = 'resume_limit_exceeded', failedAt = ARGV[7], attempts = resumes })
  redis.call('LPUSH', KEYS[9], dead)
  redis.call('LTRIM', KEYS[9], 0, 9999)
  redis.call('SET', KEYS[10], 'dead-lettered', 'EX', ARGV[9])
  redis.call('DEL', KEYS[7])
  return 'dead-lettered:' .. tostring(resumes)
end
redis.call('DEL', KEYS[7])
redis.call('SET', KEYS[10], 'ready', 'EX', ARGV[9])
redis.call('RPUSH', KEYS[8], ARGV[6])
return 'requeued'`;

export const RECOVER_PENDING_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return false end
local raw = redis.call('LINDEX', KEYS[1], 0)
if not raw then return false end
if raw ~= ARGV[1] then return 'retry' end
redis.call('LPOP', KEYS[1])
local pendingCount = tonumber(redis.call('GET', KEYS[5]) or '0')
if pendingCount > 0 then redis.call('DECR', KEYS[5]) end
redis.call('DEL', KEYS[3])
redis.call('RPUSH', KEYS[4], raw)
return raw`;

export const ENQUEUE_LUA = `
if redis.call('SET', KEYS[1], '1', 'EX', ARGV[3], 'NX') == false then return 'duplicate' end
if redis.call('EXISTS', KEYS[2]) == 1 then
  local list = redis.call('LRANGE', KEYS[3], 0, -1)
  local coalesced = 0
  for i = #list, 1, -1 do
    local ok, d = pcall(cjson.decode, list[i])
    local k = 'review'
    if ok and d and d.kind then k = d.kind end
    if k == 'review' then
      if ok and d and d.action and d.action ~= 'command' and d.action ~= 'manual' and ARGV[4] then
        local base = tostring(d.installationId) .. '/' .. d.owner .. '/' .. d.repo .. '#' .. tostring(d.pr) .. '@' .. d.headSha
        redis.call('DEL', ARGV[4] .. base)
        redis.call('DEL', ARGV[4] .. base .. ':ready_for_review')
        local suffix = ''
        if d.action == 'ready_for_review' then suffix = ':ready_for_review' end
        if d.action == 'reopened' then suffix = ':reopened' end
        redis.call('SET', ARGV[5] .. base .. suffix, 'cancelled', 'EX', ARGV[6])
      end
      redis.call('LSET', KEYS[3], i - 1, ARGV[1])
      coalesced = 1
      break
    end
  end
  if coalesced == 1 then redis.call('SET', KEYS[6], 'ready', 'EX', ARGV[6]); return 'coalesced' end
  redis.call('RPUSH', KEYS[3], ARGV[1]); redis.call('INCR', KEYS[5]); redis.call('SET', KEYS[6], 'ready', 'EX', ARGV[6]); return 'coalesced'
end
redis.call('RPUSH', KEYS[4], ARGV[1]); redis.call('SET', KEYS[6], 'ready', 'EX', ARGV[6]); return 'enqueued'`;

export const CLAIM_LUA = `
local function cleanupExpiredTenantClaims()
  local expired = redis.call('ZRANGEBYSCORE', KEYS[9], '-inf', ARGV[10], 'LIMIT', 0, 256)
  for _, claimToken in ipairs(expired) do
    local expiredTenant = redis.call('HGET', KEYS[8], claimToken)
    if expiredTenant then
      local remaining = redis.call('HINCRBY', KEYS[7], expiredTenant, -1)
      if remaining <= 0 then redis.call('HDEL', KEYS[7], expiredTenant) end
      redis.call('HDEL', KEYS[8], claimToken)
    end
    redis.call('ZREM', KEYS[9], claimToken)
  end
end
local tenantLimit = 0
if ARGV[11] == '1' then
  cleanupExpiredTenantClaims()
  tenantLimit = tonumber(redis.call('HGET', KEYS[10], ARGV[12]) or '')
  if not tenantLimit or tenantLimit < 1 then
    redis.call('LREM', KEYS[5], 1, ARGV[8])
    redis.call('LPUSH', KEYS[6], ARGV[1])
    return {'capacity_missing', ARGV[12]}
  end
  -- ARGV[1] is the job JSON (same payload DEQUEUE already selected).
  local active = tonumber(redis.call('HGET', KEYS[7], ARGV[9]) or '0')
  local decodedOk, decoded = pcall(cjson.decode, ARGV[1])
  local unlimited = decodedOk and decoded and decoded.quotaUnlimited
  if active >= tenantLimit and unlimited ~= true and unlimited ~= 'true' then
    redis.call('LREM', KEYS[5], 1, ARGV[8])
    -- LPUSH preserves queue age so this job stays ahead of later arrivals.
    redis.call('LPUSH', KEYS[6], ARGV[1])
    return 'tenant_full'
  end
end
local ok = redis.call('SET', KEYS[1], ARGV[4] .. '\\n' .. ARGV[1], 'EX', ARGV[3], 'NX')
if ok then
  if tenantLimit > 0 then
    redis.call('HSET', KEYS[8], ARGV[4], ARGV[9])
    redis.call('HINCRBY', KEYS[7], ARGV[9], 1)
    redis.call('ZADD', KEYS[9], tonumber(ARGV[10]) + tonumber(ARGV[3]) * 1000, ARGV[4])
  end
  redis.call('SET', KEYS[4], 'claimed', 'EX', ARGV[7])
  return 'claimed'
end
local coalesced = 0
if ARGV[2] == 'review' then
  local list = redis.call('LRANGE', KEYS[2], 0, -1)
  for i = #list, 1, -1 do
    local k = 'review'; local ok, d = pcall(cjson.decode, list[i]); if ok and d and d.kind then k = d.kind end
    if k == 'review' then
      if ok and d and d.action and d.action ~= 'command' and d.action ~= 'manual' and ARGV[5] then
        local base = tostring(d.installationId) .. '/' .. d.owner .. '/' .. d.repo .. '#' .. tostring(d.pr) .. '@' .. d.headSha
        redis.call('DEL', ARGV[5] .. base); redis.call('DEL', ARGV[5] .. base .. ':ready_for_review')
        if ARGV[6] and ARGV[7] then
          local suffix = ''; if d.action == 'ready_for_review' then suffix = ':ready_for_review' end; if d.action == 'reopened' then suffix = ':reopened' end
          redis.call('SET', ARGV[6] .. base .. suffix, 'cancelled', 'EX', ARGV[7])
        end
      end
      redis.call('LSET', KEYS[2], i - 1, ARGV[1]); coalesced = 1; break
    end
  end
end
if coalesced == 0 then redis.call('RPUSH', KEYS[2], ARGV[1]); redis.call('INCR', KEYS[3]) end
return 'pending'`;

export const DEQUEUE_LUA = `
local function cleanupExpiredTenantClaims()
  local expired = redis.call('ZRANGEBYSCORE', KEYS[6], '-inf', ARGV[3], 'LIMIT', 0, 256)
  for _, claimToken in ipairs(expired) do
    local tenant = redis.call('HGET', KEYS[5], claimToken)
    if tenant then
      local remaining = redis.call('HINCRBY', KEYS[4], tenant, -1)
      if remaining <= 0 then redis.call('HDEL', KEYS[4], tenant) end
      redis.call('HDEL', KEYS[5], claimToken)
    end
    redis.call('ZREM', KEYS[6], claimToken)
  end
end
local count = math.min(${DEQUEUE_INSPECTION_WINDOW}, redis.call('LLEN', KEYS[1]))
if count == 0 then redis.call('DEL', KEYS[3]); return false end
local tenantLimit = 0
if ARGV[4] == '1' then
  cleanupExpiredTenantClaims()
  tenantLimit = tonumber(redis.call('HGET', KEYS[7], ARGV[5]) or '')
  if not tenantLimit or tenantLimit < 1 then return {'capacity_missing', ARGV[5]} end
end
local forceFifo = tonumber(redis.call('GET', KEYS[3]) or '0') >= tonumber(ARGV[2])
local selectedIndex = nil; local selectedPriority = -1000000
for i = 0, count - 1 do
  local candidate = redis.call('LINDEX', KEYS[1], i); local priority = 0
  local ok, decoded = pcall(cjson.decode, candidate)
  if ok and decoded and tonumber(decoded.priority) then priority = math.floor(tonumber(decoded.priority)) end
  local tenant = ok and decoded and tostring(decoded.tenantId or '') or ''
  local unlimited = ok and decoded and decoded.quotaUnlimited
  local notBefore = ok and decoded and tonumber(decoded.availableAtMs)
  local delayed = notBefore and notBefore > tonumber(ARGV[3])
  local active = tenantLimit > 0 and tonumber(redis.call('HGET', KEYS[4], tenant) or '0') or 0
  if (not delayed) and (tenantLimit == 0 or unlimited == true or unlimited == 'true' or active < tenantLimit) then
    if forceFifo then
      selectedIndex = i
      break
    end
    if priority > selectedPriority then selectedPriority = priority; selectedIndex = i end
  end
end
if selectedIndex == nil then
  local waitingForTime = false
  for i = 0, count - 1 do
    local candidate = redis.call('LINDEX', KEYS[1], i)
    local ok, decoded = pcall(cjson.decode, candidate)
    local notBefore = ok and decoded and tonumber(decoded.availableAtMs)
    local unlimited = ok and decoded and decoded.quotaUnlimited
    local tenant = ok and decoded and tostring(decoded.tenantId or '') or ''
    local active = tenantLimit > 0 and tonumber(redis.call('HGET', KEYS[4], tenant) or '0') or 0
    local tenantOk = tenantLimit == 0 or unlimited == true or unlimited == 'true' or active < tenantLimit
    if tenantOk and notBefore and notBefore > tonumber(ARGV[3]) then
      waitingForTime = true
      break
    end
  end
  if waitingForTime then return false end
  -- All currently inspected tenants are saturated. Rotate this bounded window
  -- so a later eligible tenant is reachable in the same worker poll cycle.
  for i = 1, count do
    local blocked = redis.call('LPOP', KEYS[1])
    if not blocked then break end
    redis.call('RPUSH', KEYS[1], blocked)
  end
  return 'tenant-blocked'
end
local raw = redis.call('LINDEX', KEYS[1], selectedIndex); local marker = ARGV[1] .. ':reserved'
redis.call('LSET', KEYS[1], selectedIndex, marker); redis.call('LREM', KEYS[1], 1, marker); redis.call('RPUSH', KEYS[2], ARGV[1] .. '\\n' .. raw)
if forceFifo or selectedIndex == 0 then
  redis.call('DEL', KEYS[3])
else
  redis.call('INCR', KEYS[3])
end
return raw`;

export const DRAIN_LUA = `
local raw = redis.call('LPOP', KEYS[1])
if not raw then return false end
local pendingCount = tonumber(redis.call('GET', KEYS[3]) or '0')
if pendingCount > 0 then redis.call('DECR', KEYS[3]) end
redis.call('RPUSH', KEYS[2], raw)
return raw`;

export const REPLAY_DEAD_LETTER_LUA = `
if redis.call('EXISTS', KEYS[4]) == 1 then return 'completed' end
if redis.call('SET', KEYS[2], '1', 'EX', ARGV[3], 'NX') == false then return 'claimed' end
local removed = redis.call('LREM', KEYS[1], 1, ARGV[1])
if removed == 0 then redis.call('DEL', KEYS[2]); return 'missing' end
redis.call('RPUSH', KEYS[3], ARGV[2]); redis.call('LPUSH', KEYS[5], ARGV[4]); redis.call('LTRIM', KEYS[5], 0, 9999)
redis.call('SET', KEYS[6], 'ready', 'EX', ARGV[3]); return 'replayed'`;

/** Release an owned claim back to the ready queue without a failed/dead-letter transition. */
export const RETURN_TO_QUEUE_LUA = `
local function releaseTenantClaim()
  local tenant = redis.call('HGET', KEYS[8], ARGV[1])
  if tenant then
    local remaining = redis.call('HINCRBY', KEYS[7], tenant, -1)
    if remaining <= 0 then redis.call('HDEL', KEYS[7], tenant) end
    redis.call('HDEL', KEYS[8], ARGV[1])
  end
  redis.call('ZREM', KEYS[9], ARGV[1])
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
releaseTenantClaim()
redis.call('DEL', KEYS[1])
redis.call('LREM', KEYS[2], 1, ARGV[2])
redis.call('DEL', KEYS[3])
local pending = redis.call('LPOP', KEYS[5])
if pending then
  local pendingCount = tonumber(redis.call('GET', KEYS[6]) or '0')
  if pendingCount > 0 then redis.call('DECR', KEYS[6]) end
  redis.call('SET', KEYS[4], 'cancelled', 'EX', ARGV[4])
  redis.call('RPUSH', KEYS[10], pending)
  return 'newer-pending'
end
redis.call('SET', KEYS[4], 'ready', 'EX', ARGV[4])
-- Oldest deferred work stays at the FIFO head so later arrivals cannot jump it.
redis.call('LPUSH', KEYS[10], ARGV[3])
return 'requeued'`;
