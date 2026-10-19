"""Narration with a local Kokoro installation: kokoro-onnx (ONNX) or `kokoro` (PyTorch,
hexgrad/Kokoro-82M) — whichever this PC has.

ONNX: the session is called directly so we can read the model's per-token `duration` output.
PyTorch: KPipeline returns word tokens with start/end timestamps from the same durations.
That gives exact word timings for subtitles straight from the speech model (no speech
recognition needed). Each sentence is synthesized in one pass so prosody stays natural, and
cached on disk keyed by (text, voice, speed): editing captions, images or other scenes never
regenerates speech.
"""
import hashlib
import json
import os
import re
import threading
import zipfile
from pathlib import Path

import numpy as np

from .captions import build_captions, split_sentences

SAMPLE_RATE = 24000
FRAME_SAMPLES = 600       # one Kokoro duration unit = 600 samples (25 ms)
MAX_TOKENS = 480          # model context is 510 incl. padding; leave headroom
CACHE_VERSION = 1
PUNCTUATION = ';:,.!?¡¿—…"«»“”()[] '

LANGUAGES = {
    "a": ("American English", "en-us"), "b": ("British English", "en-gb"),
    "e": ("Spanish", "es"), "f": ("French", "fr-fr"), "h": ("Hindi", "hi"),
    "i": ("Italian", "it"), "j": ("Japanese", "ja"), "p": ("Brazilian Portuguese", "pt-br"),
    "z": ("Mandarin Chinese", "cmn"),
}


# Voices in hexgrad/Kokoro-82M v1.0 (used when the local folder doesn't list voices/*.pt).
TORCH_VOICES = ("af_alloy af_aoede af_bella af_heart af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky "
                "am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa bf_alice bf_emma "
                "bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis ef_dora em_alex em_santa ff_siwis "
                "hf_alpha hf_beta hm_omega hm_psi if_sara im_nicola jf_alpha jf_gongitsune jf_nezumi jf_tebukuro "
                "jm_kumo pf_dora pm_alex pm_santa zf_xiaobei zf_xiaoni zf_xiaoxiao zf_xiaoyi zm_yunjian zm_yunxi "
                "zm_yunxia zm_yunyang").split()


class Cancelled(Exception):
    pass


def _has_module(name):
    import importlib.util
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


class Narrator:
    def __init__(self, model_path, voices_path, cache_dir, torch_dir="", engine="auto"):
        self.model_path = model_path
        self.voices_path = voices_path
        self.torch_dir = torch_dir
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._kokoro = None
        self._tmodel = None
        self._pipes = {}
        self._lock = threading.Lock()
        self.engine = self._pick_engine(engine)

    # ---- setup -------------------------------------------------------------------------------
    def _onnx_ready(self):
        return (self.model_path and Path(self.model_path).exists() and self.voices_path
                and Path(self.voices_path).exists() and _has_module("kokoro_onnx"))

    def _torch_ready(self):
        return _has_module("kokoro") and _has_module("torch")

    def _pick_engine(self, engine):
        if engine == "onnx" or (engine == "auto" and self._onnx_ready()):
            return "onnx"
        if engine == "torch" or (engine == "auto" and self._torch_ready()):
            return "torch"
        return "onnx" if self.model_path else ("torch" if self.torch_dir else None)

    @property
    def engine_label(self):
        return {"onnx": "Kokoro (ONNX)", "torch": "Kokoro (PyTorch)"}.get(self.engine, "Kokoro")

    def check(self):
        """Return None when Kokoro is usable, otherwise a human-readable problem."""
        if self.engine == "torch":
            if not _has_module("kokoro"):
                return "The Kokoro Python package (pip install kokoro) is not installed in this Python."
            if not _has_module("torch"):
                return "PyTorch is not installed in this Python (the kokoro package needs it)."
            if self.torch_dir and not (Path(self.torch_dir) / "kokoro-v1_0.pth").exists():
                return f"kokoro-v1_0.pth was not found in {self.torch_dir}."
            return None
        if self.engine is None:
            return ("No Kokoro installation was found. Install Kokoro (hexgrad/Kokoro-82M with the `kokoro` "
                    "package, or kokoro-onnx), or click Locate Kokoro to point to its model file.")
        if not self.model_path or not Path(self.model_path).exists():
            return "Kokoro model (kokoro-v1.0.onnx) not found. Click Locate Kokoro to choose it."
        if not self.voices_path or not Path(self.voices_path).exists():
            return "Kokoro voices (voices-v1.0.bin) not found next to the model file."
        if not _has_module("kokoro_onnx"):
            return "The kokoro-onnx package is not installed in this Python."
        return None

    def voices(self):
        if self.engine == "torch":
            names = []
            if self.torch_dir and (Path(self.torch_dir) / "voices").is_dir():
                names = sorted(f.stem for f in (Path(self.torch_dir) / "voices").glob("*.pt"))
            return self._voice_list(names or TORCH_VOICES)
        if not self.voices_path or not Path(self.voices_path).exists():
            return []
        with zipfile.ZipFile(self.voices_path) as archive:
            names = sorted(Path(n).stem for n in archive.namelist() if n.endswith(".npy"))
        return self._voice_list(names)

    @staticmethod
    def _voice_list(names):
        result = []
        for name in names:
            if name[0] not in LANGUAGES:
                continue
            language = LANGUAGES[name[0]][0]
            gender = "Female" if name[1] == "f" else "Male"
            result.append({"id": name, "label": f"{name[3:].title()} — {language}, {gender}",
                           "language": language})
        return result

    def _model(self):
        if self._kokoro is None:
            from kokoro_onnx import Kokoro
            self._kokoro = Kokoro(self.model_path, self.voices_path)
        return self._kokoro

    # ---- synthesis ---------------------------------------------------------------------------
    def _phonemes_per_word(self, words, lang):
        """Phonemes for each word. Prefer the whole-sentence phonemization (context-aware) and
        split it back into words; fall back to word-by-word if the word counts don't line up."""
        import phonemizer
        vocab = self._model().tokenizer.vocab
        raw = phonemizer.phonemize([" ".join(words), *words], language=lang,
                                   preserve_punctuation=True, with_stress=True)
        clean = ["".join(ch for ch in p if ch in vocab).strip() for p in raw]
        sentence, per_word = clean[0].split(), clean[1:]
        counts = [len(p.split()) for p in per_word]
        if sum(counts) != len(sentence):
            return per_word
        out, k = [], 0
        for c in counts:
            out.append(" ".join(sentence[k:k + c]))
            k += c
        return out

    def _run(self, word_phonemes, voice, speed):
        """Synthesize one group of words. Returns (audio, [(start, end)] seconds per word)."""
        kokoro = self._model()
        vocab = kokoro.tokenizer.vocab
        tokenize = lambda s: [vocab[c] for c in s if c in vocab]  # noqa: E731
        ids, spans = [], []
        for pw in word_phonemes:
            if ids and pw:
                ids += tokenize(" ")
            start = len(ids)
            ids += tokenize(pw)
            core_end = start + len(tokenize(pw.rstrip(PUNCTUATION)))
            spans.append((start, core_end))
        style = np.asarray(kokoro.voices[voice][len(ids)], dtype=np.float32).reshape(1, -1)
        names = [i.name for i in kokoro.sess.get_inputs()]
        feed = {("input_ids" if "input_ids" in names else "tokens"): np.array([[0, *ids, 0]], dtype=np.int64),
                "style": style, "speed": np.array([speed], dtype=np.float32)}
        wav, durations = kokoro.sess.run(None, feed)[:2]
        wav = np.asarray(wav, dtype=np.float32).reshape(-1)
        # Token j (offset by the leading pad) spans cum[j+1] .. cum[j+2] samples.
        cum = np.concatenate([[0], np.cumsum(np.asarray(durations).reshape(-1))]) * FRAME_SAMPLES
        times = []
        for start, end in spans:
            s = cum[start + 1] / SAMPLE_RATE
            e = cum[max(end, start) + 1] / SAMPLE_RATE
            times.append((s, max(s, e)))
        return wav, times

    @staticmethod
    def _trim(wav, times):
        """Trim the model's leading/trailing silence, keeping soft word endings intact."""
        level = np.abs(wav)
        loud = np.nonzero(level > max(0.004, float(level.max()) * 0.01))[0]
        if not len(loud):
            return wav, times
        s = max(0, loud[0] - int(0.04 * SAMPLE_RATE))
        e = min(len(wav), loud[-1] + int(0.15 * SAMPLE_RATE))
        length = (e - s) / SAMPLE_RATE
        shift = s / SAMPLE_RATE
        times = [(min(max(a - shift, 0), length), min(max(b - shift, 0), length)) for a, b in times]
        return wav[s:e], times

    @staticmethod
    def _groups(word_phonemes):
        """Split very long sentences into chunks that fit the model, preferring punctuation."""
        groups, current, size, last_soft = [], [], 0, -1
        for i, pw in enumerate(word_phonemes):
            n = len(pw) + 1
            if current and size + n > MAX_TOKENS:
                cut = last_soft + 1 if last_soft >= 0 else len(current)
                groups.append(current[:cut])
                current = current[cut:]
                size = sum(len(word_phonemes[j]) + 1 for j in current)
                last_soft = -1
            current.append(i)
            size += n
            if pw and pw[-1] in ",;:.!?—…":
                last_soft = len(current) - 1
        if current:
            groups.append(current)
        return groups

    # ---- PyTorch engine (hexgrad/Kokoro-82M via the `kokoro` package) --------------------------
    def _torch_pipeline(self, lang_code):
        if self.torch_dir or _hf_cached():
            os.environ.setdefault("HF_HUB_OFFLINE", "1")      # model is local: never touch the network
        import torch
        from kokoro import KModel, KPipeline
        if self._tmodel is None:
            kw = {"repo_id": "hexgrad/Kokoro-82M"}
            d = Path(self.torch_dir) if self.torch_dir else None
            if d and (d / "kokoro-v1_0.pth").exists() and (d / "config.json").exists():
                kw.update(config=str(d / "config.json"), model=str(d / "kokoro-v1_0.pth"))
            device = "cuda" if torch.cuda.is_available() else "cpu"
            self._tmodel = KModel(**kw).to(device).eval()
        if lang_code not in self._pipes:
            self._pipes[lang_code] = KPipeline(lang_code=lang_code, repo_id="hexgrad/Kokoro-82M", model=self._tmodel)
        return self._pipes[lang_code]

    def _synth_torch(self, text, words, voice, speed):
        """Synthesize one sentence with KPipeline and map its token timestamps onto our words."""
        pipe = self._torch_pipeline(voice[0] if voice[0] in LANGUAGES else "a")
        local = Path(self.torch_dir) / "voices" / f"{voice}.pt" if self.torch_dir else None
        voice_arg = str(local) if local and local.exists() else voice
        spans, pos = [], 0                                   # character span of each word
        for w in words:
            start = text.index(w, pos)
            spans.append((start, start + len(w)))
            pos = start + len(w)
        word_at = lambda c: next((i for i, (a, b) in enumerate(spans) if a <= c < b), None)  # noqa: E731
        pieces, starts, ends, offset, cursor = [], {}, {}, 0.0, 0
        for result in pipe(text, voice=voice_arg, speed=float(speed), split_pattern=None):
            if result.audio is None:
                continue
            wav = result.audio.detach().cpu().numpy().astype(np.float32).reshape(-1)
            stamped = []
            for tok in (result.tokens or []):
                t = getattr(tok, "text", "") or ""
                found = text.find(t, cursor) if t else -1
                if found < 0:
                    continue
                cursor = found + len(t)
                wi = word_at(found)
                if wi is None or not re.search(r"\w", t) or tok.start_ts is None or tok.end_ts is None:
                    continue
                stamped.append((wi, float(tok.start_ts), float(tok.end_ts)))
            wav, trimmed = self._trim(wav, [(a, b) for _, a, b in stamped])
            if pieces:
                gap = np.zeros(int(0.08 * SAMPLE_RATE), dtype=np.float32)
                pieces.append(gap)
                offset += len(gap) / SAMPLE_RATE
            for (wi, _, _), (a, b) in zip(stamped, trimmed):
                starts[wi] = min(starts.get(wi, 1e9), a + offset)
                ends[wi] = max(ends.get(wi, 0.0), b + offset)
            pieces.append(wav)
            offset += len(wav) / SAMPLE_RATE
        if not pieces:
            raise RuntimeError("Kokoro returned no audio for: " + text[:60])
        audio = np.concatenate(pieces)
        total = len(audio) / SAMPLE_RATE
        times, last = [], 0.0
        if not starts:   # no timestamps (non-English voices): spread words by length as a fallback
            weights = np.cumsum([0] + [len(w) + 1 for w in words]) / (sum(len(w) + 1 for w in words) or 1)
            return audio, [(total * weights[i], total * weights[i + 1]) for i in range(len(words))]
        for i in range(len(words)):
            a = starts.get(i, last)
            b = max(a, ends.get(i, a))
            times.append((a, b))
            last = b
        return audio, times

    def _synth_onnx(self, words, voice, speed):
        lang = LANGUAGES.get(voice[0], ("", "en-us"))[1]
        word_ph = self._phonemes_per_word(words, lang)
        pieces, times, offset = [], [], 0.0
        for group in self._groups(word_ph):
            wav, group_times = self._run([word_ph[i] for i in group], voice, float(speed))
            wav, group_times = self._trim(wav, group_times)
            if pieces:
                gap = np.zeros(int(0.08 * SAMPLE_RATE), dtype=np.float32)
                pieces.append(gap)
                offset += len(gap) / SAMPLE_RATE
            pieces.append(wav)
            times += [(a + offset, b + offset) for a, b in group_times]
            offset += len(wav) / SAMPLE_RATE
        return np.concatenate(pieces).astype(np.float32), times

    def _model_id(self):
        if self.engine == "torch":
            pth = Path(self.torch_dir or "") / "kokoro-v1_0.pth"
            return f"torch:{pth.stat().st_size if pth.exists() else 'hub'}"
        return Path(self.model_path).stat().st_size      # unchanged so existing ONNX caches stay valid

    def sentence(self, text, voice, speed):
        """Audio + per-word timings for one sentence, from cache when possible.
        Returns (audio, words, times, was_cached)."""
        words = text.split()
        key = hashlib.sha1(json.dumps([CACHE_VERSION, self._model_id(),
                                       voice, round(float(speed), 3), text]).encode()).hexdigest()
        path = self.cache_dir / f"{key}.npz"
        if path.exists():
            try:
                data = np.load(path)
                return data["audio"], words, [tuple(t) for t in data["times"].tolist()], True
            except Exception:
                path.unlink(missing_ok=True)
        with self._lock:
            if self.engine == "torch":
                audio, times = self._synth_torch(text, words, voice, speed)
            else:
                audio, times = self._synth_onnx(words, voice, speed)
        audio = audio.astype(np.float32)
        tmp = path.with_suffix(".tmp.npz")
        np.savez(tmp, audio=audio, times=np.array(times, dtype=np.float64))
        tmp.replace(path)
        return audio, words, times, False

    def scene(self, script, voice, speed, sentence_gap=0.2, words_per_caption=5, cancelled=None):
        """Narration for one scene. Returns (audio, captions, sentences_synthesized)."""
        parts, captions, t, fresh = [], [], 0.0, 0
        for i, sentence in enumerate(split_sentences(script)):
            if cancelled and cancelled():
                raise Cancelled()
            audio, words, times, cached = self.sentence(sentence, voice, speed)
            fresh += 0 if cached else 1
            if i:
                gap = np.zeros(int(sentence_gap * SAMPLE_RATE), dtype=np.float32)
                parts.append(gap)
                t += len(gap) / SAMPLE_RATE
            captions += build_captions(words, times, words_per_caption, offset=t)
            parts.append(audio)
            t += len(audio) / SAMPLE_RATE
        audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        return audio, captions, fresh


def _hf_cached():
    from .config import hf_cache_dirs
    return bool(hf_cache_dirs())
