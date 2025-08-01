/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {getSystemPath, normalize, virtualFs} from '@angular-devkit/core';
import {TempScopedNodeJsSyncHost} from '@angular-devkit/core/node/testing';
import {HostTree} from '@angular-devkit/schematics';
import {SchematicTestRunner, UnitTestTree} from '@angular-devkit/schematics/testing/index.js';
import {resolve} from 'node:path';
import shx from 'shelljs';

describe('cleanup unused imports schematic', () => {
  let runner: SchematicTestRunner;
  let host: TempScopedNodeJsSyncHost;
  let tree: UnitTestTree;
  let tmpDirPath: string;
  let previousWorkingDir: string;
  let logs: string[];

  function writeFile(filePath: string, contents: string) {
    host.sync.write(normalize(filePath), virtualFs.stringToFileBuffer(contents));
  }

  function runMigration() {
    return runner.runSchematic('cleanup-unused-imports', {}, tree);
  }

  const collectionJsonPath = resolve('../collection.json');
  beforeEach(() => {
    runner = new SchematicTestRunner('test', collectionJsonPath);
    host = new TempScopedNodeJsSyncHost();
    tree = new UnitTestTree(new HostTree(host));
    logs = [];

    writeFile('/tsconfig.json', '{}');
    writeFile(
      '/angular.json',
      JSON.stringify({
        version: 1,
        projects: {t: {root: '', architect: {build: {options: {tsConfig: './tsconfig.json'}}}}},
      }),
    );

    previousWorkingDir = shx.pwd();
    tmpDirPath = getSystemPath(host.root);
    runner.logger.subscribe((log) => logs.push(log.message));

    // Switch into the temporary directory path. This allows us to run
    // the schematic against our custom unit test tree.
    shx.cd(tmpDirPath);

    writeFile(
      'directives.ts',
      `
        import {Directive} from '@angular/core';

        @Directive({selector: '[one]'})
        export class One {}

        @Directive({selector: '[two]'})
        export class Two {}

        @Directive({selector: '[three]'})
        export class Three {}
      `,
    );
  });

  afterEach(() => {
    shx.cd(previousWorkingDir);
    shx.rm('-r', tmpDirPath);
  });

  it('should clean up an array where some imports are not used', async () => {
    writeFile(
      'comp.ts',
      `
        import {Component} from '@angular/core';
        import {One, Two, Three} from './directives';

        @Component({
          imports: [Three, One, Two],
          template: '<div one></div>',
        })
        export class Comp {}
      `,
    );

    await runMigration();

    const contents = tree.readContent('comp.ts');
    expect(logs.pop()).toBe('Removed 2 imports in 1 file');
    expect(contents).toContain('imports: [One],');
    expect(contents).toContain(`import {One} from './directives';`);
  });

  it('should clean up an array where all imports are not used', async () => {
    writeFile(
      'comp.ts',
      `
        import {Component} from '@angular/core';
        import {One, Two, Three} from './directives';

        @Component({
          imports: [Three, One, Two],
          template: '',
        })
        export class Comp {}
      `,
    );

    await runMigration();

    const contents = tree.readContent('comp.ts');
    expect(logs.pop()).toBe('Removed 3 imports in 1 file');
    expect(contents).toContain('imports: [],');
    expect(contents).not.toContain(`from './directives'`);
  });

  it('should clean up an array where aliased imports are not used', async () => {
    writeFile(
      'comp.ts',
      `
        import {Component} from '@angular/core';
        import {One as OneAlias, Two as TwoAlias, Three as ThreeAlias} from './directives';

        @Component({
          imports: [ThreeAlias, OneAlias, TwoAlias],
          template: '<div one></div>',
        })
        export class Comp {}
      `,
    );

    await runMigration();
    const contents = tree.readContent('comp.ts');

    expect(logs.pop()).toBe('Removed 2 imports in 1 file');
    expect(contents).toContain('imports: [OneAlias],');
    expect(contents).toContain(`import {One as OneAlias} from './directives';`);
  });

  it('should preserve import declaration if unused import is still used within the file', async () => {
    writeFile(
      'comp.ts',
      `
        import {Component} from '@angular/core';
        import {One} from './directives';

        @Component({
          imports: [One],
          template: '',
        })
        export class Comp {}

        @Component({
          imports: [One],
          template: '<div one></div>',
        })
        export class OtherComp {}
      `,
    );

    await runMigration();
    const contents = tree.readContent('comp.ts');

    expect(logs.pop()).toBe('Removed 1 import in 1 file');
    expect(contents).toContain('imports: [],');
    expect(contents).toContain(`import {One} from './directives';`);
  });

  it('should not touch a file where all imports are used', async () => {
    const initialContent = `
      import {Component} from '@angular/core';
      import {One, Two, Three} from './directives';

      @Component({
        imports: [Three, One, Two],
        template: '<div one two three></div>',
      })
      export class Comp {}
    `;

    writeFile('comp.ts', initialContent);

    await runMigration();

    expect(logs.pop()).toBe('Schematic could not find unused imports in the project');
    expect(tree.readContent('comp.ts')).toBe(initialContent);
  });

  it('should not touch unused import declarations that are not referenced in an `imports` array', async () => {
    const initialContent = `
      import {Component} from '@angular/core';
      import {One, Two, Three} from './directives';

      @Component({template: 'Hello'})
      export class Comp {}
    `;

    writeFile('comp.ts', initialContent);

    await runMigration();

    expect(logs.pop()).toBe('Schematic could not find unused imports in the project');
    expect(tree.readContent('comp.ts')).toBe(initialContent);
  });

  it('should handle a file that is present in multiple projects', async () => {
    writeFile('/tsconfig-2.json', '{}');
    writeFile(
      '/angular.json',
      JSON.stringify({
        version: 1,
        projects: {
          a: {root: '', architect: {build: {options: {tsConfig: './tsconfig.json'}}}},
          b: {root: '', architect: {build: {options: {tsConfig: './tsconfig-2.json'}}}},
        },
      }),
    );

    writeFile(
      'comp.ts',
      `
        import {Component} from '@angular/core';
        import {One, Two, Three} from './directives';

        @Component({
          imports: [Three, One, Two],
          template: '<div one></div>',
        })
        export class Comp {}
      `,
    );

    await runMigration();
    const contents = tree.readContent('comp.ts');

    expect(logs.pop()).toBe('Removed 2 imports in 1 file');
    expect(contents).toContain('imports: [One],');
    expect(contents).toContain(`import {One} from './directives';`);
  });

  it('should preserve comments when removing unused imports', async () => {
    writeFile(
      'comp.ts',
      [
        `import {Component} from '@angular/core';`,
        `import {One, Two, Three} from './directives';`,
        ``,
        `@Component({`,
        `  imports: [`,
        `    // Start`,
        `    Three,`,
        `    One,`,
        `    Two,`,
        `    // End`,
        `  ],`,
        `  template: '<div one></div>',`,
        `})`,
        `export class Comp {}`,
      ].join('\n'),
    );

    await runMigration();

    expect(logs.pop()).toBe('Removed 2 imports in 1 file');
    expect(tree.readContent('comp.ts').split('\n')).toEqual([
      `import {Component} from '@angular/core';`,
      `import {One} from './directives';`,
      ``,
      `@Component({`,
      `  imports: [`,
      `    // Start`,
      `    One,`,
      `    // End`,
      `  ],`,
      `  template: '<div one></div>',`,
      `})`,
      `export class Comp {}`,
    ]);
  });

  it('should preserve inline comments and strip trailing comma when removing imports from same line', async () => {
    writeFile(
      'comp.ts',
      `
        import {Component} from '@angular/core';
        import {One, Two, Three} from './directives';

        @Component({
          imports: [/* Start */ Three, One, Two /* End */],
          template: '<div one></div>',
        })
        export class Comp {}
      `,
    );

    await runMigration();
    const contents = tree.readContent('comp.ts');

    expect(logs.pop()).toBe('Removed 2 imports in 1 file');
    expect(contents).toContain(' imports: [/* Start */ One/* End */],');
    expect(contents).toContain(`import {One} from './directives';`);
  });

  it('should handle all items except the first one being removed', async () => {
    writeFile(
      'comp.ts',
      `
        import {Component} from '@angular/core';
        import {One, Two, Three} from './directives';

        @Component({
          imports: [Three, One, Two],
          template: '<div three></div>',
        })
        export class Comp {}
      `,
    );

    await runMigration();

    const contents = tree.readContent('comp.ts');
    expect(logs.pop()).toBe('Removed 2 imports in 1 file');
    expect(contents).toContain('imports: [Three],');
    expect(contents).toContain(`import {Three} from './directives';`);
  });
});
