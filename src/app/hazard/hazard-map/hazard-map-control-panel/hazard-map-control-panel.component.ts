import { Component, OnInit, OnDestroy } from '@angular/core';
import { FormGroup, FormBuilder, Validators, AbstractControl } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  FormField,
  FormSelect,
  SelectOptions,
  SpinnerService,
  FormFieldService} from '@nshmp/nshmp-ng-template';
import {
  HazardResultsResponse,
  HazardResultsListing,
  HazardResultsDataType,
  HazardResults,
  NshmpError} from '@nshmp/nshmp-web-utils';
import { FeatureCollection, Feature } from 'geojson';
import { Subscription } from 'rxjs';
import * as d3 from 'd3';

import { HazardMapControlPanelService } from './hazard-map-control-panel.service';
import { HazardMapFormValues } from '../hazard-map-form-values.model';
import { HazardMapPlotService } from '../hazard-map-plot/hazard-map-plot.service';

@Component({
  selector: 'app-hazard-map-control-panel',
  templateUrl: './hazard-map-control-panel.component.html',
  styleUrls: ['./hazard-map-control-panel.component.scss']
})
export class HazardMapControlPanelComponent implements OnInit, OnDestroy {
  /* Hazard map form fields */
  hazardMapFormFields: FormField[];

  /* Subscriptions */
  getCSVSubscription = new Subscription();
  hazResultsSubscription = new Subscription();
  hazardResultsMenuSubscription = new Subscription();
  usersMenuSubscription = new Subscription();
  queryParamSubscription = new Subscription();

  /* Hazard results from nshmp-haz-results Lambda function */
  hazardResponse: HazardResultsResponse;

  /* Hazard map form group */
  hazardMapFormGroup: FormGroup = this.formBuilder.group({
    users: [Validators.required, Validators.minLength(2)],
    hazardResult: [Validators.required, Validators.minLength(2)],
    dataType: [Validators.required, Validators.minLength(2)],
    returnPeriod: [Validators.required, Validators.minLength(2)]
  });

  /* Return periods */
  private readonly SLICE_2P50 = 0.000404;
  private readonly SLICE_5P50 = 0.00103;
  private readonly SLICE_10P50 = 0.0021;

  private readonly DATA_TYPE = 'dataType';
  private readonly LAT = 'lat';
  private readonly LON = 'lon';
  private readonly NAME = 'name';
  private readonly RESULT_PREFIX = 'resultPrefix';
  private readonly RETURN_PERIOD = 'returnPeriod';
  private readonly USER = 'user';

  constructor(
      private controlPanelService: HazardMapControlPanelService,
      private formBuilder: FormBuilder,
      private plotService: HazardMapPlotService,
      private spinner: SpinnerService,
      private formService: FormFieldService,
      private route: ActivatedRoute,
      private router: Router) { }

  ngOnInit() {
    this.spinner.show('Loading ...');
    this.hazardMapFormFields = this.buildFormFields();

    this.hazResultsSubscription = this.controlPanelService.getNshmpHazResults()
        .subscribe(response => {
          this.onNshmpHazResults(response);
        }, err => {
          this.spinner.remove();
          NshmpError.throwError(err);
        });
  }

  ngOnDestroy() {
    this.hazResultsSubscription.unsubscribe();
    this.usersMenuSubscription.unsubscribe();
    this.hazardResultsMenuSubscription.unsubscribe();
    this.getCSVSubscription.unsubscribe();
    this.queryParamSubscription.unsubscribe();
  }

  onPlotMap(): void {
    this.queryParamSubscription.unsubscribe();
    this.getCSVSubscription.unsubscribe();
    this.updateQueryParameters();

    this.getCSVSubscription = this.controlPanelService.getCSVFile(this.getS3Request())
        .subscribe(csv => this.onGetCSVFile(csv),
        err => NshmpError.throwError(err));
  }

  private checkQueryParameters(params: HazardMapFormValues): void {
    if (this.DATA_TYPE in params &&
        this.RESULT_PREFIX in params &&
        this.RETURN_PERIOD in params &&
        this.USER in params) {
      this.getUsersControl().setValue(params.user);
      this.getHazardResultControl().setValue(params.resultPrefix);
      this.getDataTypeControl().setValue(params.dataType);
      this.getReturnPeriodControl().setValue(parseFloat(params.returnPeriod as string));
      if (this.hazardMapFormGroup.valid) {
        this.onPlotMap();
      }
    }
  }

  private buildDataTypeMenu(hazardResult: HazardResults): void {
    const dataTypeMenu = this.getDataTypeMenu();
    const options = this.buildDataTypeSelectOptions(hazardResult);
    dataTypeMenu.options = options;

    const control = this.getDataTypeControl();
    control.enable();
    control.setValue(this.getDataTypeId(hazardResult.listings[0].dataType));

    this.getCSVSubscription = this.controlPanelService.getCSVFile(this.getS3Request())
        .subscribe(csv => this.getReturnPeriods(csv),
        err => NshmpError.throwError(err));
  }

  private buildDataTypeSelectOptions(hazardResult: HazardResults): SelectOptions[] {
    const options: SelectOptions[] = [];

    hazardResult.listings.forEach(listing => {
      const dataType = listing.dataType;
      const id = this.getDataTypeId(dataType);

      options.push({
        label: id,
        value: id
      });
    });

    return options;
  }

  private buildFormFields(): FormField[] {
    const users: FormSelect = {
      formClass: 'grid-col-12',
      formControlName: 'users',
      formType: 'select',
      label: 'Users',
    };

    const result: FormSelect = {
      formClass: 'grid-col-12',
      formControlName: 'hazardResult',
      formType: 'select',
      label: 'Hazard Result',
    };

    const dataType: FormSelect = {
      formClass: 'grid-col-12',
      formControlName: 'dataType',
      formType: 'select',
      label: 'Data Type',
    };

    const returnPeriod: FormSelect = {
      formClass: 'grid-col-12',
      formControlName: 'returnPeriod',
      formType: 'select',
      label: 'Return Period',
    };

    return [ users, result, dataType, returnPeriod ];
  }

  private buildHazardResultMenu(hazardResults: HazardResults[]): void {
    this.hazardResultsMenuSubscription.unsubscribe();

    const resultMenu = this.getHazardResultMenu();
    const options = this.buildHazardResultSelectOptions(hazardResults);
    resultMenu.options = options;

    const control = this.getHazardResultControl();
    control.enable();
    control.setValue(hazardResults[0].resultPrefix);

    this.buildDataTypeMenu(hazardResults[0]);

    this.hazardResultsMenuSubscription = control.valueChanges.subscribe(resultPrefix => {
      this.onHazardResultsChange(resultPrefix);
    }, err => NshmpError.throwError(err));
  }

  private buildHazardResultSelectOptions(hazardResults: HazardResults[]): SelectOptions[] {
    const options: SelectOptions[] = [];

    hazardResults.forEach(result => {
      const option: SelectOptions = {
        label: result.resultPrefix,
        value: result.resultPrefix
      };
      options.push(option);
    });

    return options;
  }

  private buildReturnPeriodMenu(slices: string[]): void {
    const menu = this.getReturnPeriodMenu();
    const options = this.buildReturnPeriodSelectOptions(slices);
    menu.options = options;

    const control = this.getReturnPeriodControl();
    control.enable();
    control.setValue(slices[0]);
  }

  private buildReturnPeriodSelectOptions(slices: string[]): SelectOptions[] {
    const options: SelectOptions[] = [];

    slices.forEach(slice => {
      let label = '';
      const years = (1 / parseFloat(slice)).toFixed(0);
      switch (parseFloat(slice)) {
        case this.SLICE_2P50:
          label = `2% in 50 Years`;
          break;
        case this.SLICE_5P50:
          label = `5% in 50 Years)`;
          break;
        case this.SLICE_10P50:
          label = `10%$ in 50 Years)`;
          break;
        default:
          label = `${years} Years`;
      }

      options.push({
        label,
        value: slice
      });
    });

    return options;
  }

  private buildUsersMenu(response: HazardResultsResponse) {
    this.usersMenuSubscription.unsubscribe();

    const usersMenu = this.getUsersMenu();
    const options = this.buildUsersSelectOptions(response);
    usersMenu.options = options;

    const control = this.getUsersControl();
    control.enable();
    const initialUser = response.result.users[0];
    control.setValue(initialUser);
    this.buildHazardResultMenu(this.getHazardResults(response));

    this.usersMenuSubscription = control.valueChanges
        .subscribe(user => this.onUserChange(response, user),
        err => NshmpError.throwError(err));
  }

  private buildUsersSelectOptions(response: HazardResultsResponse): SelectOptions[] {
    const options: SelectOptions[] = [];

    response.result.users.forEach(user => {
      options.push({
        label: user,
        value: user
      });
    });

    return options;
  }

  private getControl(name: string): AbstractControl {
    return this.hazardMapFormGroup.get(name);
  }

  private getDataTypeControl(): AbstractControl {
    return this.getControl('dataType');
  }

  private getDataTypeId(dataType: HazardResultsDataType): string {
    return dataType.imt.value === dataType.sourceType.value
        ? dataType.imt.value
        : `${dataType.imt.value}.${dataType.type}.${dataType.sourceType}`;
  }

  private getDataTypeMenu(): FormSelect {
    return this.getMenu('dataType');
  }

  private getFormValues(): HazardMapFormValues {
    const values: HazardMapFormValues = {
      user: this.hazardMapFormGroup.get('users').value as string,
      dataType: this.hazardMapFormGroup.get('dataType').value as string,
      resultPrefix: this.hazardMapFormGroup.get('hazardResult').value as string,
      returnPeriod: this.hazardMapFormGroup.get('returnPeriod').value as number
    };

    return values;
  }

  private getHazardListing(response: HazardResultsResponse): HazardResultsListing {
    const values = this.getFormValues();
    const hazardResult = this.getHazardResult(response);
    return hazardResult.listings.find(listing => {
      return this.getDataTypeId(listing.dataType) === values.dataType;
    });
  }

  private getHazardResult(response: HazardResultsResponse): HazardResults {
    const values = this.getFormValues();
    const hazardResults = this.getHazardResults(response);
    return hazardResults.find(hazardResult => hazardResult.resultPrefix === values.resultPrefix);
  }

  private getHazardResults(response: HazardResultsResponse): HazardResults[] {
    const values = this.getFormValues();
    return response.result.hazardResults
        .filter(listing => listing.user === values.user);
  }

  private getHazardResultMenu(): FormSelect {
    return this.getMenu('hazardResult');
  }

  private getHazardResultControl(): AbstractControl {
    return this.getControl('hazardResult');
  }

  private getMenu(name: string): FormField {
    return this.hazardMapFormFields.find(form => {
      return form.formControlName === name;
    });
  }

  private getReturnPeriodControl(): AbstractControl {
    return this.getControl('returnPeriod');
  }

  private getReturnPeriodMenu(): FormSelect {
    return this.getMenu('returnPeriod');
  }

  private getReturnPeriods(csv: d3.DSVRowArray<string>) {
    const slices = csv.columns.slice(3, csv.columns.length);
    this.buildReturnPeriodMenu(slices);
  }

  private getS3Request(): AWS.S3.GetObjectRequest {
    const hazardResult = this.getHazardResult(this.hazardResponse);
    const listing = this.getHazardListing(this.hazardResponse);
    const bucket = `${hazardResult.bucket}/${hazardResult.user}/${listing.path}`;

    return {
      Bucket: bucket,
      Key: listing.file
    };
  }

  private getUsersControl(): AbstractControl {
    return this.getControl('users');
  }

  private getUsersMenu(): FormSelect {
    return this.getMenu('users');
  }

  private onGetCSVFile(csv: d3.DSVRowArray<string>): void {
    const fc = this.toFeatureCollection(csv);
    const slice = this.getFormValues().returnPeriod;
    const option = this.getReturnPeriodMenu().options.find(opt => opt.value === slice);
    const listing = this.getHazardListing(this.hazardResponse);

    this.plotService.geoJsonNext({
      fc,
      propertyName: this.RETURN_PERIOD,
      mapTitle: `${option.label} Probability of Exceedance`,
      legendTitle: listing.dataType.imt.display,
    });
  }

  private onHazardResultsChange(resultPrefix: string): void {
    if (resultPrefix == null) {
      return;
    }

    this.getDataTypeControl().reset();
    this.getReturnPeriodControl().reset();
    this.buildDataTypeMenu(this.getHazardResult(this.hazardResponse));
  }

  private onNshmpHazResults(response: HazardResultsResponse): void {
    this.hazardResponse = response;
    this.buildUsersMenu(response);
    this.spinner.remove();
    this.formService.markAllAsTouched(this.hazardMapFormGroup);

    this.queryParamSubscription = this.route.queryParams
        .subscribe((params: HazardMapFormValues) => this.checkQueryParameters(params),
        err => NshmpError.throwError(err));
  }

  private onUserChange(response: HazardResultsResponse, user: string) {
    this.getHazardResultControl().reset();
    this.getDataTypeControl().reset();
    this.getReturnPeriodControl().reset();
    this.buildHazardResultMenu(this.getHazardResults(response));
  }

  private toFeatureCollection(csv: d3.DSVRowArray<string>): FeatureCollection {
    const features: Feature[] = [];

    csv.forEach(row => {
      const name = row[this.NAME];
      const lat = +row[this.LAT];
      const lon = +row[this.LON];
      const formValues = this.getFormValues();
      const returnPeriod = formValues.returnPeriod;
      const slice = parseFloat(row[returnPeriod]);

      features.push({
        type: 'Feature',
        properties: {
          latitude: lat,
          longitude: lat,
          name,
          returnPeriod: slice
        },
        geometry: {
          coordinates: [lon, lat],
          type: 'Point'
        }
      });
    });

    return {
      type: 'FeatureCollection',
      features
    };
  }

  private updateQueryParameters(): void {
    const values = this.getFormValues();
    const params: HazardMapFormValues = {
      user: values.user,
      dataType: values.dataType,
      resultPrefix: values.resultPrefix,
      returnPeriod: values.returnPeriod.toString(),
    };

    this.router.navigate(['.'], {
      relativeTo: this.route,
      queryParams: params
    });
  }

}
