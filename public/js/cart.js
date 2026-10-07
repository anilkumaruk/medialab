// The request being built: selected equipment plus form values, kept per user in localStorage.
let key = 'ml_cart';
const blank = () => ({ items: [], draftId: null, fromAt: '', toAt: '', purpose: '' });

export const cart = {
  setUser(id) {
    key = `ml_cart_${id}`;
  },
  get() {
    try {
      return { ...blank(), ...JSON.parse(localStorage.getItem(key) || 'null') };
    } catch {
      return blank();
    }
  },
  save(c) {
    try {
      localStorage.setItem(key, JSON.stringify(c));
    } catch {
      /* storage unavailable - the cart just won't persist */
    }
    window.dispatchEvent(new Event('ml:cart'));
  },
  add(e, qty = 1) {
    const c = this.get();
    const found = c.items.find((i) => i.equipmentId === e.id);
    if (found) found.qty = Math.min(found.qty + qty, Math.max(1, e.available));
    else c.items.push({ equipmentId: e.id, name: e.name, category: e.category, code: e.code, qty, available: e.available });
    this.save(c);
  },
  has(id) {
    return this.get().items.find((i) => i.equipmentId === id);
  },
  update(patch) {
    this.save({ ...this.get(), ...patch });
  },
  clear() {
    this.save(blank());
  },
  count() {
    return this.get().items.reduce((n, i) => n + i.qty, 0);
  },
};
