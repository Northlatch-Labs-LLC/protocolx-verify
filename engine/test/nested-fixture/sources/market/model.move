// Nested, and carrying inline test functions in a PRODUCTION module — the shape that
// directory-based exclusion cannot see.
module nested_fixture::model {
    const EBadRate: u64 = 3;

    public fun assert_rate(bps: u64) {
        assert!(bps <= 10000, EBadRate);
    }

    #[test]
    fun rate_test() {
        assert!(1 == 1, 0);
        assert!(2 == 2, 0);
    }

    #[test_only]
    public fun helper_for_testing(x: u64) {
        assert!(x < 5, EBadRate);
    }
}
