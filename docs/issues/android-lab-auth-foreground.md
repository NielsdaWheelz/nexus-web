# native lab authentication does not prove foreground return

on source `c7c412c8`, owned api34 run
`20261103-173350-395a88e80da0` redeemed both genuine password handoffs and
confirmed the expected durable account binding and remote `/api/me` identity.
the final `native-signed-in.device.png` nevertheless shows a chrome custom tab
with a privacy error for the disposable loopback origin. the app's separate
accessibility tree shows the account-settings workspace shell. the shared pending
foreground receipt also identifies chrome's `CustomTabActivity`.

impact: background webview assertions establish account recovery, not foreground
nexus rendering or a usable pending sign-in control. the lab obtains the real
handoff through its managed browser and delivers it explicitly to the owned
activity; that does not qualify the custom tab's local certificate trust or
natural return. no hosted or physical-device failure is established. subsequent
owned-app shelf and player images support only their own observations.

resolve with an actual supported sign-in flow whose device image and foreground
identity show return to nexus, without altering device-wide trust or defaults.
retain the narrower callback, binding and remote-identity proof separately.
