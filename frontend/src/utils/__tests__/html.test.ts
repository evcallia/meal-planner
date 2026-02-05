import { describe, it, expect } from 'vitest';
import { decodeHtmlEntities } from '../html';

describe('decodeHtmlEntities', () => {
  it('returns input unchanged when there are no entities', () => {
    expect(decodeHtmlEntities('plain text')).toBe('plain text');
  });

  it('decodes named entities', () => {
    expect(decodeHtmlEntities('&lt;div&gt;Hi&amp;Bye&lt;/div&gt;'))
      .toBe('<div>Hi&Bye</div>');
    expect(decodeHtmlEntities('Tom&nbsp;&amp;&nbsp;Jerry'))
      .toBe('Tom & Jerry');
  });

  it('decodes numeric entities', () => {
    expect(decodeHtmlEntities('Letter: &#65;')).toBe('Letter: A');
    expect(decodeHtmlEntities('Hex: &#x41;')).toBe('Hex: A');
  });

  it('decodes nested entities once more when needed', () => {
    expect(decodeHtmlEntities('&amp;lt;span&amp;gt;Hi&amp;lt;/span&amp;gt;'))
      .toBe('<span>Hi</span>');
  });

  it('leaves unknown entities unchanged', () => {
    expect(decodeHtmlEntities('&unknown; &amp;')).toBe('&unknown; &');
  });
});
