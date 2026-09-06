// Fixture for shadow triage. Every function here reproduces the SHAPE of a
// guard whose behaviour under deletion was MEASURED on real code, 2026-08-30.
// The expected label for each is pinned in test_movemutate.py.
//
//  pure_construction   <- CetusProtocol/integer-mate i128::from    KILLED 16/16
//  divisor_guard       <- Sui-Volo  liquid_staking math::mul_div   SURVIVED
//  overflow_cast_guard <- Sui-Volo  liquid_staking math::mul_div   SURVIVED
//  replay_guard        <- Allen-Saji/praxis agent_registry::register SURVIVED
//
// These are shapes, not copies of anyone's product: each is the minimum code
// that reproduces the control-flow property under test.

module fixture::shadow_shapes {

    const EOverflow: u64 = 0;
    const E_DIVIDE_BY_ZERO: u64 = 500;
    const E_U64_OVERFLOW: u64 = 501;
    const EReplayDetected: u64 = 1;

    const MAX_AS_U128: u128 = 170141183460469231731687303715884105727;
    const U64_MAX: u128 = 18446744073709551615;

    struct I128 has copy, drop { bits: u128 }

    // no-fallback-abort: the tail is a struct literal. Nothing can abort, so a
    // deleted guard returns normally and ANY test touching this path notices.
    public fun pure_construction(v: u128): I128 {
        assert!(v <= MAX_AS_U128, EOverflow);
        I128 {
            bits: v
        }
    }

    // fallback-abort-correlated: `/ z` aborts on exactly the condition the
    // guard tests, and names `z`.
    public fun divisor_guard(x: u64, y: u64, z: u64): u64 {
        assert!(z != 0, E_DIVIDE_BY_ZERO);
        let r = (x as u128) * (y as u128) / (z as u128);
        r as u64
    }

    // fallback-abort-correlated: the `as u64` cast truncation-aborts on the
    // same value `r` the guard bounds.
    public fun overflow_cast_guard(r: u128): u64 {
        assert!(r <= U64_MAX, E_U64_OVERFLOW);
        r as u64
    }

    // fallback-abort-correlated: `table::add` aborts on a duplicate key, the
    // very thing the guard checks, and shares `seen_tags` / `purpose_tag`.
    public fun replay_guard(seen_tags: &mut Table, purpose_tag: vector<u8>) {
        assert!(!table::contains(seen_tags, purpose_tag), EReplayDetected);
        table::add(seen_tags, purpose_tag, true);
    }

    // no-fallback-abort: guard is the final statement.
    public fun guard_is_last(v: u64) {
        let _ = v;
        assert!(v > 0, EOverflow);
    }

    // unknown: a call this analysis does not follow, and no recognised
    // abort-capable construct. Saying "no fallback" here would be a guess.
    public fun opaque_call(v: u64) {
        assert!(v > 0, EOverflow);
        helper(v)
    }
}
