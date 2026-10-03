import { describe, expect, it } from 'vitest';
import {
  decodeXmlEntities,
  encodeXmlEntities,
  findChild,
  findChildren,
  parseXml,
} from '../../src/lib/xml.js';

describe('lib/xml', () => {
  describe('decodeXmlEntities / encodeXmlEntities', () => {
    it('round-trips the five predefined entities', () => {
      const original = 'Tom & Jerry <3 "fun" \'times\'';
      const encoded = encodeXmlEntities(original);
      expect(encoded).toContain('&amp;');
      expect(encoded).toContain('&lt;');
      expect(encoded).toContain('&quot;');
      expect(decodeXmlEntities(encoded)).toBe(original);
    });
  });

  describe('parseXml', () => {
    it('parses a Namecheap ApiResponse with attributes', () => {
      const root = parseXml(
        '<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">' +
          '<Errors /><RequestedCommand>namecheap.domains.getList</RequestedCommand>' +
          '</ApiResponse>',
      );
      expect(root.name).toBe('ApiResponse');
      expect(root.attrs['Status']).toBe('OK');
      // `<Errors />` is a self-closing child element, NOT a literal
      // string in the root's text. Asserting it shows up as a child
      // with no children of its own is the right shape.
      const errors = findChild(root, 'Errors');
      expect(errors).toBeDefined();
      expect(errors!.children).toEqual([]);
      expect(findChild(root, 'RequestedCommand')?.text).toBe('namecheap.domains.getList');
    });

    it('parses self-closing <Domain Name="…" /> children', () => {
      const root = parseXml(
        '<ApiResponse Status="OK">' +
          '<CommandResponse><DomainGetListResult>' +
          '<Domain Name="example.com" Created="2010-01-01" />' +
          '<Domain Name="example.net" />' +
          '</DomainGetListResult></CommandResponse></ApiResponse>',
      );
      // `<DomainGetListResult>` is a grandchild of `root`, not a direct
      // child — drill through `<CommandResponse>` to find it.
      const domains = findChildren(
        findChild(findChild(root, 'CommandResponse')!, 'DomainGetListResult')!,
        'Domain',
      );
      expect(domains).toHaveLength(2);
      expect(domains[0]!.attrs['Name']).toBe('example.com');
      expect(domains[0]!.children).toHaveLength(0);
    });

    it('parses self-closing <host HostId Name Type Address TTL /> entries', () => {
      const root = parseXml(
        '<ApiResponse Status="OK">' +
          '<CommandResponse><DomainDNSGetHostsResult>' +
          '<hosts>' +
          '<host HostId="1" Name="www" Type="A" Address="1.1.1.1" TTL="1800" />' +
          '<host HostId="2" Name="@" Type="A" Address="2.2.2.2" TTL="60" />' +
          '</hosts></DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      );
      const hosts = findChildren(
        findChild(findChild(findChild(root, 'CommandResponse')!, 'DomainDNSGetHostsResult')!, 'hosts')!,
        'host',
      );
      expect(hosts).toHaveLength(2);
      expect(hosts[0]!.attrs).toMatchObject({
        HostId: '1',
        Name: 'www',
        Type: 'A',
        Address: '1.1.1.1',
        TTL: '1800',
      });
    });

    it('decodes entities in attributes and text', () => {
      const root = parseXml('<Root attr="a &amp; b">Tom &amp; Jerry</Root>');
      expect(root.attrs['attr']).toBe('a & b');
      expect(root.text).toBe('Tom & Jerry');
    });

    it('throws on mismatched close tag', () => {
      expect(() => parseXml('<a></b>')).toThrow(/unexpected <\/b>/);
    });

    it('throws on unclosed tag', () => {
      expect(() => parseXml('<a>')).toThrow(/unclosed <a>/);
    });

    it('throws on multiple roots', () => {
      expect(() => parseXml('<a/><b/>')).toThrow(/multiple roots/);
    });

    it('throws on empty document', () => {
      expect(() => parseXml('')).toThrow(/empty document/);
    });

    it('skips XML comments without disturbing surrounding text', () => {
      const root = parseXml(
        '<Root><!-- comment with > inside -->' + 'actual text' + '</Root>',
      );
      expect(root.text).toBe('actual text');
    });

    it('preserves text that precedes a comment (regression: dropped text)', () => {
      // The comment branch must flush accumulated text before advancing
      // the text cursor — otherwise "hello" silently vanished.
      const root = parseXml('<a>hello<!-- c --></a>');
      expect(root.text).toBe('hello');
    });

    it('concatenates text on both sides of a comment', () => {
      const root = parseXml('<a>hello<!-- c -->world</a>');
      expect(root.text).toBe('helloworld');
    });

    it('keeps comment-only elements empty (comment never leaks into text)', () => {
      const root = parseXml('<a><!-- just a comment --></a>');
      expect(root.text).toBe('');
    });

    it('extracts single-quoted attributes (regression: silently dropped)', () => {
      // TAG_RE has always matched single-quoted attribute values, but
      // ATTR_RE only extracted double quotes — the parse "succeeded"
      // while the attrs object came back empty, so a single-quoted
      // Namecheap response lost its Status / host fields.
      const root = parseXml(
        "<ApiResponse Status='OK'>" +
          '<CommandResponse><DomainDNSGetHostsResult>' +
          "<host HostId='11' Name='www' Type='CNAME' Address='target.example.com.' TTL='1800' />" +
          '</DomainDNSGetHostsResult></CommandResponse></ApiResponse>',
      );
      expect(root.attrs['Status']).toBe('OK');
      const host = findChild(
        findChild(findChild(root, 'CommandResponse')!, 'DomainDNSGetHostsResult')!,
        'host',
      )!;
      expect(host.attrs).toMatchObject({
        HostId: '11',
        Name: 'www',
        Type: 'CNAME',
        Address: 'target.example.com.',
        TTL: '1800',
      });
    });

    it('extracts mixed quote styles in one tag and decodes entities in both', () => {
      const root = parseXml('<Root double="a &amp; b" single=\'c &apos; d\' />');
      expect(root.attrs['double']).toBe('a & b');
      expect(root.attrs['single']).toBe("c ' d");
    });
  });
});
