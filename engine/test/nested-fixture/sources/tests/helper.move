// An in-sources test DIRECTORY — excluded by path, counted, never silently dropped.
module nested_fixture::helper {
    public fun noop() {
        assert!(true, 0);
    }
}
