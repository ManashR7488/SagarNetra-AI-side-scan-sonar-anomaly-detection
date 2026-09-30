import { create } from 'zustand';

let nextId = 1;

export const useToastStore = create((set, get) => ({
  toasts: [],
  push: (message, type = 'success', ttl = 4500) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, type }] }));
    if (ttl) setTimeout(() => get().dismiss(id), ttl);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative helpers usable from stores and components. */
export const toast = {
  success: (msg) => useToastStore.getState().push(msg, 'success'),
  info: (msg) => useToastStore.getState().push(msg, 'info'),
  error: (msg) => useToastStore.getState().push(msg, 'error', 8000),
};
