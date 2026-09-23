// One shop's writes run one after another in this process: two requests that both read the stored
// scan and write it back would otherwise lose one of the two, and a double click would write twice.

const locks = new Map();

export function withShopLock(shop, fn) {
  const previous = locks.get(shop) || Promise.resolve();
  const next = previous.then(fn, fn);
  const settled = next.finally(() => {
    if (locks.get(shop) === settled) locks.delete(shop);
  });
  locks.set(shop, settled);
  return next;
}
