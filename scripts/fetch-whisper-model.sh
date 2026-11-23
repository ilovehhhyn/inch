#!/usr/bin/env bash
# Downloads the whisper.cpp base.en speech model (MIT licence, 148 MB) into Margin's models folder and checks its SHA-256.
# Usage: scripts/fetch-whisper-model.sh [destination-directory]
set -euo pipefail

# Pinned: the Hugging Face commit that holds the file, and the digest and size Hugging Face publishes for it.
REVISION="5359861c739e955e79d9a303bcbc70fb988958b1"
FILE="ggml-base.en.bin"
SHA256="a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"
SIZE_BYTES="147964211"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/${REVISION}/${FILE}"

DESTINATION="${1:-${HOME}/Library/Application Support/Margin/models}"
TARGET="${DESTINATION}/${FILE}"

digest_of() {
  shasum -a 256 "$1" | cut -d ' ' -f 1
}

if [ -f "${TARGET}" ] && [ "$(digest_of "${TARGET}")" = "${SHA256}" ]; then
  echo "${TARGET} is already present and matches ${SHA256}"
  exit 0
fi

mkdir -p "${DESTINATION}"
TEMPORARY="$(mktemp "${DESTINATION}/${FILE}.XXXXXX")"
trap 'rm -f "${TEMPORARY}"' EXIT

echo "downloading ${FILE} (${SIZE_BYTES} bytes) from ${URL}"
curl --fail --location --retry 3 --silent --show-error --output "${TEMPORARY}" "${URL}"

ACTUAL="$(digest_of "${TEMPORARY}")"
if [ "${ACTUAL}" != "${SHA256}" ]; then
  echo "error: ${FILE} has SHA-256 ${ACTUAL} but ${SHA256} was expected; the download was discarded, so try again or check the network" >&2
  exit 1
fi

mv "${TEMPORARY}" "${TARGET}"
trap - EXIT
echo "saved ${TARGET}"
