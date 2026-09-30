const silent = process.env.NODE_ENV === 'test';
const stamp = () => new Date().toISOString();

export const logger = {
  info: (...args) => !silent && console.log(stamp(), 'INFO ', ...args),
  warn: (...args) => !silent && console.warn(stamp(), 'WARN ', ...args),
  error: (...args) => console.error(stamp(), 'ERROR', ...args),
};
