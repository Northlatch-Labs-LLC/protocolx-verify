module fixture::synthetic {
    const EBad: u64 = 1;

    // assert!(this_is_a_comment, EBad);
    /* block comment with assert!(nested, EBad);
       /* nested block */ still a comment assert!(x, EBad); */

    public fun guard(a: u64, b: u64) {
        assert!(a >= b, EBad);
        let msg = b"a string containing assert!(fake, EBad);";
        assert!(
            a + 1 > b,
            EBad
        );
    }

    /// Last expression, no trailing semicolon — invisible to a `);` predicate.
    public fun tail_guard(ok: bool) {
        assert!(ok, EBad)
    }

    public fun generic_guard<T>(v: &vector<T>) {
        assert!(std::vector::length<T>(v) > 0, EBad);
    }

    public fun with_return(a: u64): u64 {
        assert!(a > 0, EBad);
        a
    }

    #[test]
    fun inline_test() {
        assert!(1 == 1, 0);
    }

    #[test_only]
    public fun helper_for_testing(a: u64) {
        assert!(a < 10, EBad);
    }

    #[test, expected_failure]
    fun inline_failing_test() {
        assert!(false, 0);
    }
}
