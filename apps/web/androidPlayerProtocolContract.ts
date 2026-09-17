import protocolContract from "../../contracts/android-player-protocol.json";

/** Shared web/native compatibility identity, independent of build contents. */
export function androidPlayerProtocolContractSha256(): string {
  if (
    protocolContract.version !== 2 ||
    !/^[0-9a-f]{64}$/u.test(protocolContract.contract_sha256)
  ) {
    throw new Error("Android player protocol contract identity is invalid.");
  }
  return protocolContract.contract_sha256;
}
