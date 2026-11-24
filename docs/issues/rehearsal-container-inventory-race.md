# a vanished container can fail detached rehearsal cleanup

the predecessor apk built successfully during the `15e15f096` journal android
rehearsal. `takeover-android-15e15f0-034630/upgrade-build/receipt.json` records
check exit 0 and retained cleanup. another run removed containers between the
rehearsal's `docker container ls` and bulk `docker container inspect`. inspect
returned `no such container` for ids `2fbe660f4835` and `c2e384bac739`. the wrapper
returned failure despite the completed build and left its detached checkout.

resolve in dev-server by tolerating inspected ids that are proved absent while
still checking every surviving mount and preserving real inventory errors.
