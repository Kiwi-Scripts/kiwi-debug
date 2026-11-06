/** Runs `fn`; `undefined` if it throws. For code that calls into the page or the framework, which must never break the overlay. */
export function safe<T>( fn: () => T ): T | undefined {
    try {
        return fn();
    } catch {
        return undefined;
    }
}

/** Like {@link safe}, with a fallback instead of `undefined`. */
export function safeOr<T>( fn: () => T, fallback: T ): T {
    try {
        return fn();
    } catch {
        return fallback;
    }
}
