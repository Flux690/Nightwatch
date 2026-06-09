// Tests run against a dedicated Redis logical database so they never share
// BullMQ queues, rate-limit keys, or heartbeat keys with the dev server on the
// same instance. db 15 is the conventional throwaway database. The vitest
// config exports this as REDIS_URL before any module reads process.env, and the
// global setup flushes this database before the run.
export const TEST_REDIS_URL = "redis://localhost:6380/15";
