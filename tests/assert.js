export function assert(condition, message = 'Assertion failed') {
    if (!condition)
        throw new Error(message);
}
export function equal(actual, expected, message = '') {
    assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
export function throws(fn) {
    let thrown = false;
    try { fn(); } catch { thrown = true; }
    assert(thrown, 'Expected an exception');
}
