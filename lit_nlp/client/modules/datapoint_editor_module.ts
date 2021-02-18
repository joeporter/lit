/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// tslint:disable:no-new-decorators
import * as d3 from 'd3';  // Used for computing quantile, not visualization.
import {customElement, html} from 'lit-element';
import {styleMap} from 'lit-html/directives/style-map';
import {computed, observable, when} from 'mobx';

import {app} from '../core/lit_app';
import {LitModule} from '../core/lit_module';
import {defaultValueByField, EdgeLabel, formatEdgeLabel, formatSpanLabel, IndexedInput, Input, ModelInfoMap, SpanLabel, Spec} from '../lib/types';
import {isLitSubtype} from '../lib/utils';
import {GroupService} from '../services/group_service';
import {SelectionService} from '../services/selection_service';

import {styles} from './datapoint_editor_module.css';
import {styles as sharedStyles} from './shared_styles.css';

// Converter function for text input. Use to support non-string types,
// such as numeric fields.
type InputConverterFn = (s: string) => string|number|string[];

/**
 * A LIT module that allows the user to view and edit a datapoint.
 */
@customElement('datapoint-editor-module')
export class DatapointEditorModule extends LitModule {
  static title = 'Datapoint Editor';
  static numCols = 2;
  static template = (model = '', selectionServiceIndex = 0) => {
    return html`<datapoint-editor-module selectionServiceIndex=${
        selectionServiceIndex}></datapoint-editor-module>`;
  };

  static duplicateForExampleComparison = true;
  static duplicateForModelComparison = false;

  private readonly groupService = app.getService(GroupService);

  static get styles() {
    return [sharedStyles, styles];
  }

  private resizeObserver!: ResizeObserver;
  private isShiftPressed = false; /** Newline edits are shift + enter */

  @observable editedData: Input = {};
  @observable datapointEdited: boolean = false;
  @observable inputHeights: {[name: string]: string} = {};

  @computed
  get dataTextLengths(): {[key: string]: number} {
    const defaultLengths: {[key: string]: number} = {};

    // The string length at this percentile in the input data sample is used
    // to determine the default height of the input box.
    const percentileForDefault = 0.8;

    // Get non-categorical keys.
    const keys = this.appState.currentInputDataKeys.filter((key) => {
      return !(
          this.groupService.categoricalFeatureNames.includes(key) ||
          this.groupService.numericalFeatureNames.includes(key));
    });
    // Get input string lengths for non-categorical keys.
    for (const key of keys) {
      const lengths = this.appState.currentInputData.map(
          indexedInput => indexedInput.data[key]?.length);
      defaultLengths[key] = d3.quantile(lengths, percentileForDefault) ?? 1;
    }
    return defaultLengths;
  }

  firstUpdated() {
    const container = this.shadowRoot!.getElementById('edit-table')!;
    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(container);


    const getCurrentDataset = () => this.appState.currentDataset;
    this.reactImmediately(getCurrentDataset, () => {
      when(() => this.appState.currentInputDataIsLoaded, () => {
        this.resize();
        this.resetEditedData(null);
      });
    });

    const getSelectedData = () =>
        this.selectionService.primarySelectedInputData;
    this.reactImmediately(getSelectedData, selectedData => {
      this.resetEditedData(selectedData == null ? null : selectedData.data);
    });
  }

  updated() {
    // Hack to fix the fact that just updating the innerhtml of the dom doesn't
    // update the displayed value of textareas. See
    // https://github.com/elm/virtual-dom/issues/115#issuecomment-329405689.
    const textareas = Array.from(this.shadowRoot!.querySelectorAll('textarea'));
    for (const textarea of textareas) {
      textarea.value = textarea.textContent!;
    }
  }

  private resize() {
    // Get the first input box element, used for  getting the client width to
    // compute the input box height below.
    const inputBoxElement =
        this.shadowRoot!.querySelectorAll('.input-box')[0] as HTMLElement;
    if (inputBoxElement == null) return;

    const keys = Array.from(Object.keys(this.dataTextLengths));
    for (const key of keys) {
      const defaultCharLength = this.dataTextLengths[key];

      // Heuristic for computing height.
      const characterWidth = 13;  // estimate for character width in pixels
      const numLines = Math.ceil(
          characterWidth * defaultCharLength / inputBoxElement.clientWidth);
      const pad = 1;
      // Set 2 ex per line.
      this.inputHeights[key] = `${2 * numLines + pad}ex`;
    }
  }

  private growToTextSize(e: KeyboardEvent) {
    const elt = e.target as HTMLElement;
    elt.style.height = `${elt.scrollHeight}px`;
  }

  private resetEditedData(selectedInputData: Input|null) {
    this.datapointEdited = false;
    const data: Input = {};

    // If no datapoint is selected, then show an empty datapoint to fill in.
    const keys = selectedInputData == null ?
        this.appState.currentInputDataKeys :
        Object.keys(selectedInputData);
    const spec = this.appState.currentDatasetSpec;
    for (const key of keys) {
      data[key] = selectedInputData == null ? defaultValueByField(key, spec) :
                                              selectedInputData[key];
    }
    this.editedData = data;
  }

  render() {
    return html`
      <div class='module-container'>
        <div id="container" class='module-results-area'>
          ${this.renderEditText()}
        </div>
        <div id="buttons">
          ${this.renderButtons()}
        </div>
      </div>
    `;
  }

  /**
   * Returns false if any of the required model inputs are blank.
   */
  @computed
  private get allRequiredInputsFilledOut() {
    const keys = Object.keys(this.editedData);
    let allRequiredInputsFilledOut = true;
    for (let i = 0; i < keys.length; i++) {
      if (this.appState.currentModelRequiredInputSpecKeys.includes(keys[i]) &&
          this.editedData[keys[i]] === '') {
        allRequiredInputsFilledOut = false;
        break;
      }
    }
    return allRequiredInputsFilledOut;
  }

  renderButtons() {
    const makeEnabled = this.datapointEdited && this.allRequiredInputsFilledOut;
    const compareEnabled = makeEnabled && !this.appState.compareExamplesEnabled;
    const resetEnabled = this.datapointEdited;
    const clearEnabled = !!this.selectionService.primarySelectedInputData;

    const onClickNew = async () => {
      const datum: IndexedInput = {
        data: this.editedData,
        id: '',  // will be overwritten
        meta: {
          source: 'manual',
          added: true,
          parentId: this.selectionService.primarySelectedId!
        },
      };
      const data: IndexedInput[] = await this.appState.indexDatapoints([datum]);
      this.appState.commitNewDatapoints(data);
      this.selectionService.selectIds(data.map(d => d.id));
    };
    const onClickCompare = async () => {
      const parentId = this.selectionService.primarySelectedId!;
      await onClickNew();
      this.appState.compareExamplesEnabled = true;
      // By default, both selections will be synced to the newly-created
      // datapoint. We want to set the reference to be the original parent
      // example.
      app.getServiceArray(SelectionService)[1].selectIds([parentId]);
    };
    const onClickReset = () => {
      this.resetEditedData(
          this.selectionService.primarySelectedInputData!.data);
    };
    const onClickClear = () => {
      this.selectionService.selectIds([]);
    };

    const analyzeButton = html`
      <button id="make" class='hairline-button'
        @click=${onClickNew} ?disabled="${!makeEnabled}">
        Add
      </button>
    `;
    const compareButton = html`
      <button id="compare" class='hairline-button'
        @click=${onClickCompare} ?disabled="${!compareEnabled}">
        Add and compare
      </button>
    `;
    const resetButton = html`
      <button id="reset" class='hairline-button'
        @click=${onClickReset}  ?disabled="${!resetEnabled}">
        Reset
      </button>
    `;
    const clearButton = html`
      <button id="clear" class='hairline-button'
        @click=${onClickClear}  ?disabled="${!clearEnabled}">
        Clear
      </button>
    `;

    // clang-format off
    return html`
      ${analyzeButton}
      ${compareButton}
      ${resetButton}
      ${clearButton}
    `;
    // clang-format off
  }

  renderEditText() {
    const keys = Object.keys(this.appState.currentDatasetSpec);
    const editable = true;
    // clang-format off
    return html`
      <div id="edit-table">
       ${keys.map(
            (key) => this.renderEntry(key, this.editedData[key], editable))}
      </div>
    `;
    // clang-format on
  }

  // tslint:disable-next-line:no-any
  renderEntry(key: string, value: any, editable: boolean) {
    const handleInputChange =
        (e: Event, converterFn: InputConverterFn = (s => s)) => {
          this.datapointEdited = true;
          // tslint:disable-next-line:no-any
          this.editedData[key] = converterFn((e as any).target.value as string);
        };

    // For categorical outputs, render a dropdown.
    const renderCategoricalInput = (catVals: string[]) => {
      // Note that the first option is blank (so that the dropdown is blank when
      // no point is selected), and disabled (so that datapoints can only have
      // valid values).
      return html`
      <select class="dropdown"
        @change=${handleInputChange}>
        <option value="" selected></option>
        ${catVals.map(val => {
        return html`
            <option
              value="${val}"
              ?selected=${val === value}
              >
              ${val}
            </option>`;
      })}
      </select>`;
    };

    const inputStyle = {'height': this.inputHeights[key]};
    // Render a multi-line text input.
    const renderFreeformInput = () => {
      return html`
      <textarea class="input-box" style="${styleMap(inputStyle)}" @input=${
          handleInputChange}
        ?readonly="${!editable}">${value}</textarea>`;
    };

    // Render a single-line text input.
    const renderShortformInput = () => {
      return html`
      <input type="text" class="input-short" @input=${handleInputChange}
        ?readonly="${!editable}" .value=${value}></input>`;
    };

    // Render a single-line text input, and convert entered value to a number.
    const renderNumericInput = () => {
      const handleNumberInput = (e: Event) => {
        handleInputChange(e, (value: string) => +(value));
      };
      return html`
      <input type="text" class="input-short" @input=${handleNumberInput}
        ?readonly="${!editable}" .value=${value}></input>`;
    };

    // Render tokens as space-separated, but re-split for editing.
    const renderTokensInput = () => {
      const handleTokensInput = (e: Event) => {
        handleInputChange(e, (value: string): string[] => {
          // If value is empty, return [] instead of ['']
          return value ? value.split(' ') : [];
        });
      };
      const valueAsString = value ? value.join(' ') : '';
      return html`
      <textarea class="input-box" style="${styleMap(inputStyle)}" @input=${
          handleTokensInput}
        ?readonly="${!editable}">${valueAsString}</textarea>`;
    };

    // Display multi-label inputs as separator-separated.
    const renderSparseMultilabelInputGenerator = (separator: string) => {
      return () => {
        const handleSparseMultilabelInput = (e: Event) => {
          handleInputChange(e, (value: string): string[] => {
            // If value is empty, return [] instead of ['']
            return value ? value.split(separator) : [];
          });
        };
        const valueAsString = value ? value.join(separator) : '';
        return html`
        <textarea class="input-box" style="${styleMap(inputStyle)}" @input=${
            handleSparseMultilabelInput}
          ?readonly="${!editable}">${valueAsString}</textarea>`;
      };
    };

    // Non-editable render for span labels.
    const renderSpanLabelsNonEditable = () => {
      const renderLabel = (d: SpanLabel) =>
          html`<div class="span-label">${formatSpanLabel(d)}</div>`;
      return html`${value ? (value as SpanLabel[]).map(renderLabel) : null}`;
    };
    // Non-editable render for edge labels.
    const renderEdgeLabelsNonEditable = () => {
      const renderLabel = (d: EdgeLabel) => {
        return html`<div class="edge-label">${formatEdgeLabel(d)}</div>`;
      };
      return html`${value ? (value as EdgeLabel[]).map(renderLabel) : null}`;
    };

    let renderInput = renderFreeformInput;  // default: free text
    const fieldSpec = this.appState.currentDatasetSpec[key];
    const vocab = fieldSpec?.vocab;
    if (vocab != null) {
      renderInput = () => renderCategoricalInput(vocab);
    } else if (this.groupService.categoricalFeatureNames.includes(key)) {
      renderInput = renderShortformInput;
    } else if (this.groupService.numericalFeatureNames.includes(key)) {
      renderInput = renderNumericInput;
    } else if (isLitSubtype(fieldSpec, ['Tokens', 'SequenceTags'])) {
      renderInput = renderTokensInput;
    } else if (isLitSubtype(fieldSpec, 'SpanLabels')) {
      renderInput = renderSpanLabelsNonEditable;
    } else if (isLitSubtype(fieldSpec, 'EdgeLabels')) {
      renderInput = renderEdgeLabelsNonEditable;
    } else if (isLitSubtype(fieldSpec, 'SparseMultilabel')) {
      renderInput =
          renderSparseMultilabelInputGenerator(fieldSpec.separator ?? ',');
    }

    // Shift + enter creates a newline; enter alone creates a new datapoint.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') this.isShiftPressed = false;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') this.isShiftPressed = true;
      if (e.key === 'Enter') {
        if (!this.isShiftPressed) {
          e.preventDefault();
          this.shadowRoot!.getElementById('make')!.click();
        }
      }
    };

    // TODO(lit-team): Have better indication of model inputs vs other fields.
    // TODO(lit-team): Should we also display optional input fields that aren't
    // in the dataset? b/157985221.
    const isRequiredModelInput =
        this.appState.currentModelRequiredInputSpecKeys.includes(key);

    let headerContent = html`${isRequiredModelInput ? '*' : ''}${key}`;
    if (isLitSubtype(fieldSpec, 'URL')) {
      headerContent = html`
        <a href=${value as string} target="_blank">
          ${headerContent}
          <mwc-icon class="icon-button">open_in_new</mwc-icon>
        </a>`;
    } else if (isLitSubtype(fieldSpec, 'SearchQuery')) {
      const params = new URLSearchParams();
      params.set('q', value);
      headerContent = html`
        <a href="https://www.google.com/search?${params.toString()}" target="_blank">
          ${headerContent}
          <mwc-icon class="icon-button">search</mwc-icon>
        </a>`;
    }

    // Note the "." before "value" in the template below - this is to ensure
    // the value gets set by the template.
    // clang-format off
    return html`
      <div class="entry"
        @input=${(e: KeyboardEvent) => {this.growToTextSize(e);}}
        @keyup=${(e: KeyboardEvent) => {onKeyUp(e);}}
        @keydown=${(e: KeyboardEvent) => {onKeyDown(e);}}
        >
        <div class='field-header'>
          <div class='field-name'>${headerContent}</div>
          <div class='field-type'>(${fieldSpec.__name__})</div>
        </div>
        <div>
          ${renderInput()}
        </div>
      </div>
    `;
    // clang-format on
  }

  static shouldDisplayModule(modelSpecs: ModelInfoMap, datasetSpec: Spec) {
    return true;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'datapoint-editor-module': DatapointEditorModule;
  }
}
