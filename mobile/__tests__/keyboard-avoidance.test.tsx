import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, render } from '@testing-library/react-native';
import { useEffect } from 'react';
import { Keyboard, Platform, Text } from 'react-native';

import useKeyboardHeight, { NEEDS_MANUAL_KEYBOARD_SCROLL } from '../hooks/useKeyboardHeight';
import { scrollOffsetForField } from '../lib/keyboardScroll';

/**
 * Keyboard avoidance — the focused field stays visible while the keyboard is open.
 *
 * WHY THIS SUITE EXISTS. Device measurement 2026-10-14 (OPPO CPH1969, development
 * build, Expo SDK 57 / React Native 0.86.3, edge-to-edge) showed this build's Android
 * window does NOT resize for the keyboard (its frame stayed `[0,0][1080,2340]` with the
 * IME reported over `[0,1443][1080,2340]`) and that the platform does not scroll the
 * focused input into view either: with the keyboard open the Adjust Stock form's fields
 * sat at exactly the coordinates they had before it opened, so the field the member had
 * just tapped sat underneath the keyboard. `KeyboardAvoidingView` did nothing on Android
 * because its `behavior` was `undefined` there, which React Native treats as "the window
 * resizes itself" — and it does not.
 *
 * So the fix has three parts, and they are checked at the three levels they can be:
 *
 *   1. the ARITHMETIC of "is the field covered, and by how much" — a pure function,
 *      exercised directly (the bottom of this file would otherwise be the only coverage);
 *   2. the KEYBOARD GEOMETRY the shells need — the hook, exercised through React Native's
 *      own `Keyboard` emitter, including the guard that stops a re-render storm;
 *   3. the WIRING between them — Screen, Input, KeyboardScrollView and Sheet. There is no
 *      honest way to execute this in Jest: `@testing-library/react-native` v14 renders only
 *      host components, so the `behavior` prop on `KeyboardAvoidingView` and a ref's
 *      `measureInWindow` are both absent from the test tree (verified, not assumed — a probe
 *      walking the rendered tree found zero nodes carrying `behavior`, and host refs expose
 *      no `measureInWindow`). The wiring is therefore guarded at the source, and every guard
 *      carries a POSITIVE CONTROL: the predicate is applied to a deliberately mutated copy
 *      of the same source and must fire, so a guard that has silently stopped describing
 *      anything cannot pass. The Android behaviour itself is proven on the device, not here.
 */

/** Source with comments and string literals stripped, so a scan reads CODE. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const readSource = (relative: string): string =>
  readFileSync(path.resolve(__dirname, '..', relative), 'utf8');

const SCREEN = readSource('components/Screen.tsx');
const INPUT = readSource('components/Input.tsx');
const SCROLL = readSource('components/KeyboardScrollView.tsx');
const SHEET = readSource('components/Sheet.tsx');
const PRODUCT_FORM = readSource('components/ProductForm.tsx');

describe('scrollOffsetForField', () => {
  const base = { fieldTop: 1000, fieldHeight: 56, visibleBottom: 1443, currentOffset: 0, margin: 24 };

  it('leaves a field that is already visible exactly where it is', () => {
    // 1000 + 56 + 24 = 1080 <= 1443, so nothing is covered and the screen must not jump.
    expect(scrollOffsetForField(base)).toBe(0);
  });

  it('moves a covered field by exactly the amount it is covered by, plus the margin', () => {
    // 1400 + 56 + 24 - 1443 = 37
    expect(scrollOffsetForField({ ...base, fieldTop: 1400 })).toBe(37);
  });

  it('adds the margin rather than stopping flush against the keyboard', () => {
    // Field bottom 1411 + 56 = 1467 is 24 PAST the keyboard's top edge (1443), and the margin
    // keeps another 24 of breathing room on top of that, so the move is 24 + 24 — not the
    // field's whole height. Stopping at the edge itself would leave the field's own error text
    // (which renders under it) clipped.
    expect(scrollOffsetForField({ ...base, fieldTop: 1411 })).toBe(48);
  });

  it('scrolls when the SCROLL VIEW ends above the keyboard, not only when the keyboard covers the field', () => {
    // The shell shortens itself by the keyboard's height, so the scroll view can end at 1200.
    // A field at 1180 is below its own scroll view: clipped and invisible even though the
    // keyboard is not what is covering it, so scrolling to the keyboard's edge would not help.
    expect(scrollOffsetForField({ ...base, fieldTop: 1180, visibleBottom: 1200 })).toBe(60);
  });

  it('never returns a negative offset — there is nothing above the content to reveal', () => {
    expect(scrollOffsetForField({ ...base, fieldTop: 0, fieldHeight: 0, visibleBottom: 0, margin: 0 })).toBe(0);
  });

  it('is stable: re-computing after the move asks for no further movement', () => {
    // Applying the offset is what scrolls the field into view, and the hook re-runs on every
    // geometry change. If the function were not idempotent in this sense, each re-run would
    // scroll again and a form would drift down the screen.
    const first = scrollOffsetForField({ ...base, fieldTop: 1400 });
    const second = scrollOffsetForField({ ...base, fieldTop: 1400 - first, currentOffset: first });
    expect(second).toBe(first);
  });
});

describe('useKeyboardHeight', () => {
  /**
   * A probe that records the geometry and how often an EFFECT keyed on that geometry re-ran.
   * The hook's guard exists so a consumer's effect — the scroll-into-view in
   * `KeyboardScrollView` is exactly one — does not re-run for a keyboard animation step that
   * reports the geometry it already has.
   */
  let effectRuns = 0;
  let latest: { height: number; top: number } = { height: 0, top: 0 };

  function Probe() {
    const geometry = useKeyboardHeight();
    latest = geometry;
    useEffect(() => {
      effectRuns += 1;
    }, [geometry]);
    return <Text testID="geometry">{`${geometry.height}:${geometry.top}`}</Text>;
  }

  /** React Native's own emitter, so the hook's real registration path is exercised. */
  const emitter = (Keyboard as unknown as { _emitter: { emit: (event: string, payload: unknown) => void } })
    ._emitter;

  const show = (height: number, screenY: number) =>
    act(() => {
      emitter.emit('keyboardDidShow', { endCoordinates: { height, screenY } });
    });

  beforeEach(() => {
    effectRuns = 0;
    latest = { height: 0, top: 0 };
  });

  it('reports the keyboard height and its top edge once the keyboard is shown', async () => {
    await render(<Probe />);
    await show(897, 1443);
    expect(latest).toEqual({ height: 897, top: 1443 });
  });

  it('returns to zero when the keyboard hides', async () => {
    await render(<Probe />);
    await show(897, 1443);
    await act(() => {
      emitter.emit('keyboardDidHide', {});
    });
    expect(latest).toEqual({ height: 0, top: 0 });
  });

  it('follows a keyboard that changes size without hiding (an emoji panel)', async () => {
    await render(<Probe />);
    await show(897, 1443);
    await act(() => {
      emitter.emit('keyboardDidChangeFrame', { endCoordinates: { height: 500, screenY: 1840 } });
    });
    expect(latest).toEqual({ height: 500, top: 1840 });
  });

  it('leaves the geometry alone when a frame event reports what it already has', async () => {
    // `keyboardDidChangeFrame` fires for animation steps, and its payload is usually the same
    // number again. A fresh object with equal fields would re-run every consumer's effect — the
    // scroll-into-view is one — on each of those, for nothing, so the guard is the whole point.
    //
    // The assertion is on the EFFECT, not on a render count: React documents that it may still
    // render the component once before bailing out of a same-value update, so counting renders
    // would pin an implementation detail of the scheduler rather than this hook's contract. What
    // the contract actually promises is that the value a consumer sees does not change.
    await render(<Probe />);
    await show(897, 1443);
    const geometryAfterShow = latest;
    const effectsAfterShow = effectRuns;

    await act(() => {
      emitter.emit('keyboardDidChangeFrame', { endCoordinates: { height: 897, screenY: 1443 } });
      emitter.emit('keyboardDidChangeFrame', { endCoordinates: { height: 897, screenY: 1443 } });
    });

    expect(effectRuns).toBe(effectsAfterShow);
    // The same OBJECT, not merely the same numbers: that is what keeps a dependency array quiet.
    expect(latest).toBe(geometryAfterShow);
  });
});

describe('the keyboard decision is derived from the platform', () => {
  it('asks for a manual scroll on Android only, because iOS already does it natively', () => {
    // A double scroll on iOS would fight the platform's own and can overshoot, so this is a
    // real platform decision rather than a constant. The suite runs on jest-expo's iOS
    // project, so the value here is `false`; what is pinned is that it IS the platform.
    expect(NEEDS_MANUAL_KEYBOARD_SCROLL).toBe(Platform.OS === 'android');
  });
});

describe('the wiring (source guards, each with a positive control)', () => {
  /**
   * Every guard below is a predicate over one file's code. `check` runs it; `control` proves
   * it can fail by running it against a mutated copy. A predicate that fires on nothing is
   * decoration, and one that fires on everything is worse.
   */
  function guard(name: string, source: string, predicate: (body: string) => boolean, mutate: (body: string) => string) {
    it(name, () => {
      const body = code(source);
      // The guard has to describe real code …
      expect({ name, guarded: predicate(body) }).toEqual({ name, guarded: true });
      const mutated = mutate(body);
      // … the mutation has to have landed (a mutation that cannot apply is not evidence) …
      expect(mutated).not.toBe(body);
      // … and the same guard has to fire on the shape it exists to catch.
      expect({ name, firesOnMutant: predicate(mutated) }).toEqual({ name, firesOnMutant: false });
    });
  }

  guard(
    'Screen lifts bottom-anchored content by the MEASURED keyboard height',
    SCREEN,
    (body) => /keyboardHeight\s*>\s*0\s*&&\s*\{\s*paddingBottom\s*:\s*keyboardHeight\s*\}/.test(body),
    (body) => body.replace(/\{\s*paddingBottom\s*:\s*keyboardHeight\s*\}/, '{}'),
  );

  guard(
    'Screen does not branch the keyboard lift by platform',
    SCREEN,
    (body) => !/Platform\.OS/.test(body),
    (body) =>
      body.replace(
        /\{\s*paddingBottom\s*:\s*keyboardHeight\s*\}/,
        "{ paddingBottom: Platform.OS === 'ios' ? keyboardHeight : 0 }",
      ),
  );

  guard(
    'Screen does not go back to KeyboardAvoidingView, which measured as inert on the device',
    SCREEN,
    (body) => !/KeyboardAvoidingView/.test(body),
    (body) => `const wrapped = <KeyboardAvoidingView behavior="padding">${body}</KeyboardAvoidingView>;`,
  );

  guard(
    'Screen gives the scroll CONTENT room beyond the keyboard, so the last field can be scrolled up',
    SCREEN,
    (body) => /keyboardHeight\s*>\s*0\s*&&\s*\{\s*paddingBottom\s*:\s*keyboardHeight\s*\+\s*spacing\.lg\s*\}/.test(body),
    (body) =>
      body.replace(
        /keyboardHeight\s*>\s*0\s*&&\s*\{\s*paddingBottom\s*:\s*keyboardHeight\s*\+\s*spacing\.lg\s*\}/,
        'false',
      ),
  );

  guard(
    'Input tells the enclosing scroll view which field was focused',
    INPUT,
    (body) => /reportFocusToScrollView\?\.\(inputRef\.current\)/.test(body),
    (body) => body.replace('reportFocusToScrollView?.(inputRef.current)', ''),
  );

  guard(
    'KeyboardScrollView decides the offset with the tested function and scrolls to it',
    SCROLL,
    (body) => /scrollOffsetForField\(/.test(body) && /scroll\.scrollTo\(/.test(body),
    (body) => body.replace('scrollOffsetForField(', 'ignore(').replace('scroll.scrollTo(', 'nothing('),
  );

  guard(
    'KeyboardScrollView only scrolls further down, so a visible field never jumps to the top',
    SCROLL,
    (body) => /if\s*\(target\s*>\s*offset\.current\)/.test(body),
    (body) => body.replace('if (target > offset.current)', 'if (true)'),
  );

  guard(
    'ProductForm returns to a missing required name when submit fails validation',
    PRODUCT_FORM,
    (body) =>
      /if\s*\(problems\.name\)\s*requestAnimationFrame\(\(\)\s*=>\s*nameRef\.current\?\.focus\(\)\)/.test(body) &&
      /<Input\s+ref=\{nameRef\}/.test(body),
    (body) => body.replace('nameRef.current?.focus()', '').replace('ref={nameRef}', ''),
  );

  guard(
    'Sheet is lifted by the keyboard instead of waiting for a window resize that never comes',
    SHEET,
    (body) => /keyboardHeight\s*>\s*0\s*&&\s*\{\s*paddingBottom\s*:\s*keyboardHeight/.test(body),
    (body) => body.replace(/keyboardHeight\s*>\s*0\s*&&\s*\{\s*paddingBottom\s*:\s*keyboardHeight\s*\}/, 'false'),
  );
});
