// Nested one level below sources/ — the shape a flat `sources/*.move` glob cannot see.
module nested_fixture::access {
    const ENotAuthorized: u64 = 1;
    const EBadKey: u64 = 2;

    public fun assert_authorized(who: address, owner: address) {
        assert!(who == owner, ENotAuthorized);
    }

    public fun assert_key_bounds(n: u64) {
        assert!(n >= 1, EBadKey);
        assert!(n <= 16, EBadKey);
    }
}
