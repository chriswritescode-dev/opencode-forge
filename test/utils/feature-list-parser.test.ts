import { describe, it, expect } from 'vitest'
import {
  FEATURES_START_MARKER,
  FEATURES_END_MARKER,
  parseFeatureList,
} from '../../src/utils/feature-list-parser'

describe('parseFeatureList', () => {
  it('parses a valid feature list block', () => {
    const text = [
      'prefix text',
      FEATURES_START_MARKER,
      JSON.stringify([
        { title: 'Feature A', description: 'Description A' },
        { title: 'Feature B', description: 'Description B' },
      ]),
      FEATURES_END_MARKER,
      'suffix text',
    ].join('\n')

    const result = parseFeatureList(text)
    expect(result).toEqual({
      ok: true,
      features: [
        { title: 'Feature A', description: 'Description A' },
        { title: 'Feature B', description: 'Description B' },
      ],
    })
  })

  it('trims whitespace from title and description', () => {
    const text = [
      FEATURES_START_MARKER,
      JSON.stringify([
        { title: '  spaced title  ', description: '  spaced desc  ' },
      ]),
      FEATURES_END_MARKER,
    ].join('\n')

    const result = parseFeatureList(text)
    expect(result).toEqual({
      ok: true,
      features: [{ title: 'spaced title', description: 'spaced desc' }],
    })
  })

  it('returns missing when no markers present', () => {
    expect(parseFeatureList('no markers here')).toEqual({
      ok: false,
      reason: 'missing',
    })
  })

  it('returns missing for empty string', () => {
    expect(parseFeatureList('')).toEqual({ ok: false, reason: 'missing' })
  })

  it('returns unterminated when start marker without end marker', () => {
    const text = [
      FEATURES_START_MARKER,
      JSON.stringify([{ title: 'x', description: 'y' }]),
    ].join('\n')

    expect(parseFeatureList(text)).toEqual({
      ok: false,
      reason: 'unterminated',
    })
  })

  it('returns unterminated when end marker without start marker', () => {
    const text = [
      JSON.stringify([{ title: 'x', description: 'y' }]),
      FEATURES_END_MARKER,
    ].join('\n')

    expect(parseFeatureList(text)).toEqual({
      ok: false,
      reason: 'unterminated',
    })
  })

  it('returns unterminated when end marker precedes start marker', () => {
    const text = [
      FEATURES_END_MARKER,
      JSON.stringify([{ title: 'x', description: 'y' }]),
      FEATURES_START_MARKER,
    ].join('\n')

    expect(parseFeatureList(text)).toEqual({
      ok: false,
      reason: 'unterminated',
    })
  })

  it('returns invalid_json when content is not valid JSON', () => {
    const text = [
      FEATURES_START_MARKER,
      'not valid json',
      FEATURES_END_MARKER,
    ].join('\n')

    expect(parseFeatureList(text)).toEqual({
      ok: false,
      reason: 'invalid_json',
    })
  })

  it('returns empty when JSON is an empty array', () => {
    const text = [
      FEATURES_START_MARKER,
      '[]',
      FEATURES_END_MARKER,
    ].join('\n')

    expect(parseFeatureList(text)).toEqual({
      ok: false,
      reason: 'empty',
    })
  })

  it('returns invalid_shape when element has no title', () => {
    const text = [
      FEATURES_START_MARKER,
      JSON.stringify([{ description: 'foo' }]),
      FEATURES_END_MARKER,
    ].join('\n')

    expect(parseFeatureList(text)).toEqual({
      ok: false,
      reason: 'invalid_shape',
    })
  })

  it('returns invalid_shape when element has no description', () => {
    const text = [
      FEATURES_START_MARKER,
      JSON.stringify([{ title: 'foo' }]),
      FEATURES_END_MARKER,
    ].join('\n')

    expect(parseFeatureList(text)).toEqual({
      ok: false,
      reason: 'invalid_shape',
    })
  })

  it('returns invalid_shape when title is empty after trim', () => {
    const text = [
      FEATURES_START_MARKER,
      JSON.stringify([{ title: '  ', description: 'desc' }]),
      FEATURES_END_MARKER,
    ].join('\n')

    expect(parseFeatureList(text)).toEqual({
      ok: false,
      reason: 'invalid_shape',
    })
  })

  it('returns invalid_shape when description is empty after trim', () => {
    const text = [
      FEATURES_START_MARKER,
      JSON.stringify([{ title: 'title', description: '' }]),
      FEATURES_END_MARKER,
    ].join('\n')

    expect(parseFeatureList(text)).toEqual({
      ok: false,
      reason: 'invalid_shape',
    })
  })

  it('returns invalid_shape when element is not an object', () => {
    const text = [
      FEATURES_START_MARKER,
      JSON.stringify(['not an object']),
      FEATURES_END_MARKER,
    ].join('\n')

    expect(parseFeatureList(text)).toEqual({
      ok: false,
      reason: 'invalid_shape',
    })
  })

  it('returns invalid_shape when JSON value is not an array', () => {
    const text = [
      FEATURES_START_MARKER,
      JSON.stringify({ title: 'x', description: 'y' }),
      FEATURES_END_MARKER,
    ].join('\n')

    expect(parseFeatureList(text)).toEqual({
      ok: false,
      reason: 'invalid_shape',
    })
  })
})
