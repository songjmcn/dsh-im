import test from 'node:test';
import { deepStrictEqual, equal } from 'node:assert';

import { INJECTED_CONTEXT_TAGS } from '../../../src/channels/shared/context-enhancement.mjs';
import { prependSpeakerLabel } from '../../../src/channels/shared/speaker-label.mjs';

test('prependSpeakerLabel labels a string prompt inline', () => {
  equal(prependSpeakerLabel('描述一下这个图片', 'Bob'), 'Bob: 描述一下这个图片');
  equal(prependSpeakerLabel('问题', '  bob  '), 'bob: 问题', 'the label is trimmed');
});

test('prependSpeakerLabel passes content through when no label applies', () => {
  equal(prependSpeakerLabel('问题', ''), '问题');
  equal(prependSpeakerLabel('问题', '   '), '问题', 'a whitespace name is no name');
  equal(prependSpeakerLabel('问题', null), '问题');
  equal(prependSpeakerLabel(undefined, 'Bob'), undefined);
  equal(prependSpeakerLabel('', 'Bob'), '', 'no prompt text is invented out of an empty body');
  equal(prependSpeakerLabel(42, 'Bob'), 42, 'foreign shapes are left alone');
});

test('prependSpeakerLabel labels the first body text part of a structured prompt', () => {
  const replyBlock = { type: 'text', text: `${INJECTED_CONTEXT_TAGS.replyOpen}{"content":"引用"}${INJECTED_CONTEXT_TAGS.replyClose}` };
  const image = { type: 'image', mediaType: 'image/png', data: 'AA==', name: 'cat.png' };
  const content = [replyBlock, { type: 'text', text: '描述一下这个图片' }, image];
  const original = structuredClone(content);
  const labelled = prependSpeakerLabel(content, 'Bob');
  deepStrictEqual(labelled, [
    replyBlock,
    { type: 'text', text: 'Bob: 描述一下这个图片' },
    image,
  ], 'injected blocks keep their provenance and the body text carries the label once');
  deepStrictEqual(content, original, 'the input array and its parts are never mutated');
});

test('prependSpeakerLabel places a label part ahead of media when no body text exists', () => {
  const replyBlock = { type: 'text', text: `${INJECTED_CONTEXT_TAGS.replyOpen}{}${INJECTED_CONTEXT_TAGS.replyClose}` };
  const contextBlock = { type: 'text', text: `${INJECTED_CONTEXT_TAGS.contextOpen}{}${INJECTED_CONTEXT_TAGS.contextClose}` };
  const image = { type: 'image', mediaType: 'image/jpeg', data: 'AA==', name: 'cat.jpg' };
  const labelled = prependSpeakerLabel([replyBlock, contextBlock, image], 'Bob');
  deepStrictEqual(labelled, [{ type: 'text', text: 'Bob:' }, replyBlock, contextBlock, image]);
});
