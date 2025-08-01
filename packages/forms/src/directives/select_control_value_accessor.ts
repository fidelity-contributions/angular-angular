/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  afterNextRender,
  ApplicationRef,
  ChangeDetectorRef,
  DestroyRef,
  Directive,
  ElementRef,
  forwardRef,
  Host,
  inject,
  Input,
  OnDestroy,
  Optional,
  Provider,
  Renderer2,
  ɵRuntimeError as RuntimeError,
} from '@angular/core';

import {RuntimeErrorCode} from '../errors';

import {
  BuiltInControlValueAccessor,
  ControlValueAccessor,
  NG_VALUE_ACCESSOR,
} from './control_value_accessor';

const SELECT_VALUE_ACCESSOR: Provider = {
  provide: NG_VALUE_ACCESSOR,
  useExisting: forwardRef(() => SelectControlValueAccessor),
  multi: true,
};

function _buildValueString(id: string | null, value: any): string {
  if (id == null) return `${value}`;
  if (value && typeof value === 'object') value = 'Object';
  return `${id}: ${value}`.slice(0, 50);
}

function _extractId(valueString: string): string {
  return valueString.split(':')[0];
}

/**
 * @description
 * The `ControlValueAccessor` for writing select control values and listening to select control
 * changes. The value accessor is used by the `FormControlDirective`, `FormControlName`, and
 * `NgModel` directives.
 *
 * @usageNotes
 *
 * ### Using select controls in a reactive form
 *
 * The following examples show how to use a select control in a reactive form.
 *
 * {@example forms/ts/reactiveSelectControl/reactive_select_control_example.ts region='Component'}
 *
 * ### Using select controls in a template-driven form
 *
 * To use a select in a template-driven form, simply add an `ngModel` and a `name`
 * attribute to the main `<select>` tag.
 *
 * {@example forms/ts/selectControl/select_control_example.ts region='Component'}
 *
 * ### Customizing option selection
 *
 * Angular uses object identity to select option. It's possible for the identities of items
 * to change while the data does not. This can happen, for example, if the items are produced
 * from an RPC to the server, and that RPC is re-run. Even if the data hasn't changed, the
 * second response will produce objects with different identities.
 *
 * To customize the default option comparison algorithm, `<select>` supports `compareWith` input.
 * `compareWith` takes a **function** which has two arguments: `option1` and `option2`.
 * If `compareWith` is given, Angular selects option by the return value of the function.
 *
 * ```ts
 * const selectedCountriesControl = new FormControl();
 * ```
 *
 * ```html
 * <select [compareWith]="compareFn"  [formControl]="selectedCountriesControl">
 *    @for(country of countries; track $index) {
 *        <option[ngValue]="country">{{country.name}}</option>
 *    }
 * </select>
 *
 * compareFn(c1: Country, c2: Country): boolean {
 *     return c1 && c2 ? c1.id === c2.id : c1 === c2;
 * }
 * ```
 *
 * **Note:** We listen to the 'change' event because 'input' events aren't fired
 * for selects in IE, see:
 * https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/input_event#browser_compatibility
 *
 * @ngModule ReactiveFormsModule
 * @ngModule FormsModule
 * @publicApi
 */
@Directive({
  selector:
    'select:not([multiple])[formControlName],select:not([multiple])[formControl],select:not([multiple])[ngModel]',
  host: {'(change)': 'onChange($any($event.target).value)', '(blur)': 'onTouched()'},
  providers: [SELECT_VALUE_ACCESSOR],
  standalone: false,
})
export class SelectControlValueAccessor
  extends BuiltInControlValueAccessor
  implements ControlValueAccessor
{
  /** @docs-private */
  value: any;

  /** @internal */
  _optionMap: Map<string, any> = new Map<string, any>();

  /** @internal */
  _idCounter: number = 0;

  /**
   * @description
   * Tracks the option comparison algorithm for tracking identities when
   * checking for changes.
   */
  @Input()
  set compareWith(fn: (o1: any, o2: any) => boolean) {
    if (typeof fn !== 'function' && (typeof ngDevMode === 'undefined' || ngDevMode)) {
      throw new RuntimeError(
        RuntimeErrorCode.COMPAREWITH_NOT_A_FN,
        `compareWith must be a function, but received ${JSON.stringify(fn)}`,
      );
    }
    this._compareWith = fn;
  }

  private _compareWith: (o1: any, o2: any) => boolean = Object.is;
  // We need this because we might be in the process of destroying the root
  // injector, which is marked as destroyed before running destroy hooks.
  // Attempting to use afterNextRender with the node injector would evntually
  // run into that already destroyed injector.
  private readonly appRefInjector = inject(ApplicationRef).injector;
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);
  private _queuedWrite = false;

  /**
   * This is needed to efficiently set the select value when adding/removing options. If
   * writeValue is instead called for every added/removed option, this results in exponentially
   * more _compareValue calls than the number of option elements (issue #41330).
   *
   * Secondly, calling writeValue when rendering individual option elements instead of after they
   * are all rendered caused an issue in Safari and IE 11 where the first option element failed
   * to be deselected when no option matched the select ngModel. This was because Angular would
   * set the select element's value property before appending the option's child text node to the
   * DOM (issue #14505).
   *
   * Finally, this approach is necessary to avoid an issue with delayed element removal when
   * using the animations module (in all browsers). Otherwise when a selected option is removed
   * (so no option matches the ngModel anymore), Angular would change the select element value
   * before actually removing the option from the DOM. Then when the option is finally removed
   * from the DOM, the browser would change the select value to that of the first option, even
   * though it doesn't match the ngModel (issue #18430).
   *
   * @internal
   */
  _writeValueAfterRender(): void {
    if (this._queuedWrite || this.appRefInjector.destroyed) {
      return;
    }

    this._queuedWrite = true;

    afterNextRender(
      {
        write: () => {
          if (this.destroyRef.destroyed) {
            return;
          }
          this._queuedWrite = false;
          this.writeValue(this.value);
        },
      },
      {injector: this.appRefInjector},
    );
  }

  /**
   * Sets the "value" property on the select element.
   * @docs-private
   */
  writeValue(value: any): void {
    // TODO(atscott): This could likely be optimized more by only marking for check if the value is changed
    // note that this needs to include both the internal value and the value in the DOM.
    this.cdr.markForCheck();
    this.value = value;
    const id: string | null = this._getOptionId(value);
    const valueString = _buildValueString(id, value);
    this.setProperty('value', valueString);
  }

  /**
   * Registers a function called when the control value changes.
   * @docs-private
   */
  override registerOnChange(fn: (value: any) => any): void {
    this.onChange = (valueString: string) => {
      this.value = this._getOptionValue(valueString);
      fn(this.value);
    };
  }

  /** @internal */
  _registerOption(): string {
    return (this._idCounter++).toString();
  }

  /** @internal */
  _getOptionId(value: any): string | null {
    for (const id of this._optionMap.keys()) {
      if (this._compareWith(this._optionMap.get(id), value)) return id;
    }
    return null;
  }

  /** @internal */
  _getOptionValue(valueString: string): any {
    const id: string = _extractId(valueString);
    return this._optionMap.has(id) ? this._optionMap.get(id) : valueString;
  }
}

/**
 * @description
 * Marks `<option>` as dynamic, so Angular can be notified when options change.
 *
 * @see {@link SelectControlValueAccessor}
 *
 * @ngModule ReactiveFormsModule
 * @ngModule FormsModule
 * @publicApi
 */
@Directive({
  selector: 'option',
  standalone: false,
})
export class NgSelectOption implements OnDestroy {
  /**
   * @description
   * ID of the option element
   */
  id!: string;

  constructor(
    private _element: ElementRef,
    private _renderer: Renderer2,
    @Optional() @Host() private _select: SelectControlValueAccessor,
  ) {
    if (this._select) this.id = this._select._registerOption();
  }

  /**
   * @description
   * Tracks the value bound to the option element. Unlike the value binding,
   * ngValue supports binding to objects.
   */
  @Input('ngValue')
  set ngValue(value: any) {
    if (this._select == null) return;
    this._select._optionMap.set(this.id, value);
    this._setElementValue(_buildValueString(this.id, value));
    this._select._writeValueAfterRender();
  }

  /**
   * @description
   * Tracks simple string values bound to the option element.
   * For objects, use the `ngValue` input binding.
   */
  @Input('value')
  set value(value: any) {
    this._setElementValue(value);
    if (this._select) this._select._writeValueAfterRender();
  }

  /** @internal */
  _setElementValue(value: string): void {
    this._renderer.setProperty(this._element.nativeElement, 'value', value);
  }

  /** @docs-private */
  ngOnDestroy(): void {
    if (this._select) {
      this._select._optionMap.delete(this.id);
      this._select._writeValueAfterRender();
    }
  }
}
