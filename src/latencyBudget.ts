// Tiny helpers for keeping editor-facing work inside a strict latency budget.

export interface BudgetResult<T> {
  completed: boolean;
  value?: T;
}

/** Resolves with a value only when the promise finishes inside the budget. */
export function withLatencyBudget<T>(promise: PromiseLike<T>, budgetMs: number): Promise<BudgetResult<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ completed: false }), budgetMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ completed: true, value });
      },
      () => {
        clearTimeout(timer);
        resolve({ completed: true });
      }
    );
  });
}
