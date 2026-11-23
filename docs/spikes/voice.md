# Voice, attachments and model choice: measurements

This page records what was measured for Tasks 20 to 23 on one Mac (Apple silicon, macOS, 2026-11-23), with the limit of each result.

## Dictation: five runs

The plan asks for five dictations of "does this look right?" by a person, with the word error and the time from key release to send. A person could not do this here, because macOS asks a person to allow microphone access to Electron and the prompt blocks until someone answers it. The runs below use five macOS synthetic voices as the window's microphone. The real recorder ran (MediaRecorder, decoding, resampling to 16 kHz mono, WAV writing), then the real whisper.cpp `base.en` model, then a send to a scripted Codex. The command was `MARGIN_MEASURE_VOICE=1 npx playwright test voice-measure` (`tests/e2e/voice-measure.spec.ts`).

| Run | Voice | Heard | Word error | Key release to sent message (ms) |
| --- | --- | --- | --- | --- |
| 1 | Samantha | Does this look right? | 0 of 4 | 1,044 |
| 2 | Daniel | Does this look right? | 0 of 4 | 490 |
| 3 | Karen | Does this look right? | 0 of 4 | 491 |
| 4 | Moira | Does this look right? | 0 of 4 | 573 |
| 5 | Tessa | Does this look right? | 0 of 4 | 498 |

What this shows: the whole path works, and after the first run key release to send takes about 0.5 s. Run 1 includes the one-time SHA-256 check of the 148 MB model.

What it does not show: how well whisper.cpp hears a person. A synthetic voice is clean, close to the training distribution and the same phrase each time, so a word error of 0 is a floor. The microphone itself, room noise and the macOS permission prompt were not exercised. A person still has to run the manual check once: hold the right ⌥ key, say the phrase five times, and read the word error from the sent messages.

## Cold start of whisper.cpp

The first `whisper-cli` run after installing it took 28.4 s wall time for a 1-second recording. Later runs took 0.4 s. The cause was not isolated (a one-time cost such as compiled GPU code or a first-launch check of the binary are candidates). One run is not a distribution. The dictation limit is 30 s (`TRANSCRIBE_TIMEOUT_MS`), so a first dictation on a fresh Mac could have timed out. Margin therefore transcribes half a second of silence at start-up with a 120 s limit (`WARM_UP_TIMEOUT_MS`); a failure there is logged only, and the first dictation shows the same reason.

## Real Codex turns (3 turns, the most the controller allowed)

The built app ran against the real `codex-cli 0.146.0` with a scratch user-data folder. All three turns went to `gpt-5.6-sol`.

| Turn | What was sent | Result |
| --- | --- | --- |
| 1 | A 2 by 2 red PNG attached with "What colour is the attached image? Answer with one word." Reasoning `low`, the default. | The answer was "Red". The image reached Codex as a `localImage` item. |
| 2 | "In one word: what is 2 plus 2?" with the reasoning picker changed from `low` to `medium`. | The answer was "Four". |
| 3 | A spoken message: the synthetic voice Samantha through the real recorder and the real whisper.cpp, sent with the context of the chat. | Heard "Does this look right?". The answer said it had read the chat "What colour is the attached image?" and that both answers looked right, so the context arrived. Key release to sent message: 597 ms. Time to the first word of the answer: 3,320 ms (one send, which is not a median). |

Codex's own rollout file for the run shows the model and effort it stored for each turn: `gpt-5.6-sol` with `low`, `medium` and `medium`. The effort change therefore reached the model, not only the request.

The model list of this account was GPT-5.6-Sol, GPT-5.6-Terra and GPT-5.6-Luna, with the levels `low`, `medium`, `high`, `xhigh`, `max` and `ultra`. The default level of the default model was `low`.

## System voices for reading aloud

In the built app's window `speechSynthesis.getVoices()` returned 0 voices on the first call and 191 after the `voiceschanged` event (the default was Samantha, en-US, a local voice). A silent utterance started and ended. So the macOS system voices are available inside Electron, and no other speech engine was added. Nothing was spoken aloud during this check.

## Not measured

- Attachments to a Claude chat were never sent to Anthropic; the block shapes were checked against a mocked client and the bundled API reference.
- A PDF sent to Codex was checked as extracted text in unit tests and in the packaged app (`dist/mac-arm64/Margin.app` against a scripted Codex, where `pdfjs-dist` resolved inside `app.asar`), not against a real model.
- Real dictation by a person.
