export function log(level, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    ...data
  };
  console.log(JSON.stringify(entry));
}
