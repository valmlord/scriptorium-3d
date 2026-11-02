/**
 * The shape of `golden-vectors.json`.
 *
 * Declared once and shared by the regeneration script and the test that reads
 * the fixture, so that a change to the fixture's structure cannot quietly make
 * the test assert on a field that is no longer written.
 *
 * This file holds types only: it is test data, not part of the library.
 */

/** An address with its room serialised as a decimal string. */
export interface GoldenAddress {
  room: string;
  wall: number;
  shelf: number;
  volume: number;
  page: number;
}

/** A page identified by its address, pinned by hash and opening characters. */
export interface GoldenPage {
  name: string;
  note: string;
  address: GoldenAddress;
  sha256: string;
  first64: string;
  title: string;
}

/** A page identified by its text, pinned by the address it resolves to. */
export interface GoldenLocation {
  name: string;
  note: string;
  pageSha256: string;
  address: GoldenAddress;
}

/** A search result: the phrase, where it was placed, and where it landed. */
export interface GoldenSearch {
  query: string;
  mode: string;
  offset: number;
  address: GoldenAddress;
}

/** The frozen format parameters (SPEC §4.5), restated so a drift is visible. */
export interface GoldenParameters {
  domainTag: string;
  rounds: number;
  prfBytes: number;
  pageLength: number;
  radix: number;
  alphabet: string;
}

export interface GoldenVectors {
  $comment: string;
  formatVersion: number;
  parameters: GoldenParameters;
  pages: GoldenPage[];
  locations: GoldenLocation[];
  searches: GoldenSearch[];
  invalid: {
    note: string;
    linear: string;
    librarySize: string;
  };
}
