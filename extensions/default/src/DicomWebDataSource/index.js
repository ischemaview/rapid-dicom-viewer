import { pubSubServiceInterface } from '@ohif/core';
import { api } from 'dicomweb-client';
import {
  DicomMetadataStore,
  IWebApiDataSource,
  utils,
  errorHandler,
  classes,
} from '@ohif/core';

import {
  mapParams,
  search as qidoSearch,
  seriesInStudy,
  processResults,
  processSeriesResults,
} from './qido.js';
import dcm4cheeReject from './dcm4cheeReject';

import getImageId from './utils/getImageId';
import dcmjs from 'dcmjs';
import {
  retrieveStudyMetadata,
  deleteStudyMetadataPromise,
} from './retrieveStudyMetadata.js';
import StaticWadoClient from './utils/StaticWadoClient.js';
import getDirectURL from '../utils/getDirectURL.js';

const { DicomMetaDictionary, DicomDict } = dcmjs.data;

const { naturalizeDataset, denaturalizeDataset } = DicomMetaDictionary;

const ImplementationClassUID =
  '2.25.270695996825855179949881587723571202391.2.0.0';
const ImplementationVersionName = 'OHIF-VIEWER-2.0.0';
const EXPLICIT_VR_LITTLE_ENDIAN = '1.2.840.10008.1.2.1';

const metadataProvider = classes.MetadataProvider;
let _dicomWebConfig = null;
let _qidoDicomWebClient = null;
let _wadoDicomWebClient = null;
/**
 *
 * @param {string} name - Data source name
 * @param {string} wadoUriRoot - Legacy? (potentially unused/replaced)
 * @param {string} qidoRoot - Base URL to use for QIDO requests
 * @param {string} wadoRoot - Base URL to use for WADO requests
 * @param {boolean} qidoSupportsIncludeField - Whether QIDO supports the "Include" option to request additional fields in response
 * @param {string} imageRengering - wadors | ? (unsure of where/how this is used)
 * @param {string} thumbnailRendering - wadors | ? (unsure of where/how this is used)
 * @param {bool} supportsReject - Whether the server supports reject calls (i.e. DCM4CHEE)
 * @param {bool} lazyLoadStudy - "enableStudyLazyLoad"; Request series meta async instead of blocking
 * @param {string|bool} singlepart - indicates of the retrieves can fetch singlepart.  Options are bulkdata, video, image or boolean true
 */
function createDicomWebApi(webConfig, userAuthenticationService) {
  const initClients = config => {
    _dicomWebConfig = config;

    const qidoConfig = {
      url: config.qidoRoot,
      staticWado: config.staticWado,
      singlepart: config.singlepart,
      headers: userAuthenticationService.getAuthorizationHeader(),
      errorInterceptor: errorHandler.getHTTPErrorHandler(),
    };

    const wadoConfig = {
      url: config.wadoRoot,
      staticWado: config.staticWado,
      singlepart: config.singlepart,
      headers: userAuthenticationService.getAuthorizationHeader(),
      errorInterceptor: errorHandler.getHTTPErrorHandler(),
    };

    // TODO -> Two clients sucks, but its better than 1000.
    // TODO -> We'll need to merge auth later.
    _qidoDicomWebClient = config.staticWado
      ? new StaticWadoClient(qidoConfig)
      : new api.DICOMwebClient(qidoConfig);

    _wadoDicomWebClient = config.staticWado
      ? new StaticWadoClient(wadoConfig)
      : new api.DICOMwebClient(wadoConfig);
  };

  initClients(webConfig);

  const pubSubService = Object.assign(
    {
      EVENTS: {
        NEW_STUDY: 'event::DicomWebDatasource::NEW_STUDY',
        RELOAD_STUDY: 'event::DicomWebDatasource::RELOAD_STUDY',
      },
      listeners: [],
    },
    pubSubServiceInterface
  );

  const implementation = {
    updateConfig: dicomWebConfig => {
      initClients(dicomWebConfig);
    },
    onNewStudy: callback => {
      pubSubService.subscribe(pubSubService.EVENTS.NEW_STUDY, callback);
    },
    onReloadStudy: callback => {
      pubSubService.subscribe(pubSubService.EVENTS.RELOAD_STUDY, callback);
    },
    reloadStudy: ({ studyInstanceUIDs, seriesInstanceUIDs }) => {
      pubSubService._broadcastEvent(pubSubService.EVENTS.RELOAD_STUDY, {
        studyInstanceUIDs,
        seriesInstanceUIDs,
      });
    },
    setNewStudy: ({ studyInstanceUIDs, seriesInstanceUIDs }) => {
      pubSubService._broadcastEvent(pubSubService.EVENTS.NEW_STUDY, {
        studyInstanceUIDs,
        seriesInstanceUIDs,
      });
    },
    initialize: ({ params, query }) => {
      const { StudyInstanceUIDs: paramsStudyInstanceUIDs } = params;
      const { SeriesInstanceUIDs: paramsSeriesInstanceUIDs } = params;
      const queryStudyInstanceUIDs = query.getAll('StudyInstanceUIDs');
      const querySeriesInstanceUIDs = query.getAll('SeriesInstanceUIDs');

      const StudyInstanceUIDs =
        (queryStudyInstanceUIDs.length && queryStudyInstanceUIDs) ||
        paramsStudyInstanceUIDs;
      const StudyInstanceUIDsAsArray =
        StudyInstanceUIDs && Array.isArray(StudyInstanceUIDs)
          ? StudyInstanceUIDs
          : [StudyInstanceUIDs];


      const SeriesInstanceUIDs =
        querySeriesInstanceUIDs || paramsSeriesInstanceUIDs;
      const SeriesInstanceUIDsAsArray =
        SeriesInstanceUIDs && Array.isArray(SeriesInstanceUIDs)
          ? SeriesInstanceUIDs
          : [SeriesInstanceUIDs];


      let result = {
        studyInstanceUIDs: StudyInstanceUIDsAsArray,
        seriesInstanceUIDs: SeriesInstanceUIDsAsArray,
        filters: null,
        sortCriteria: null,
        sortFunction: null,
      };

      return result;
    },
    query: {
      studies: {
        mapParams: mapParams.bind(),
        search: async function(origParams) {
          const headers = userAuthenticationService.getAuthorizationHeader();
          if (headers) {
            _qidoDicomWebClient.headers = headers;
          }

          const { studyInstanceUid, seriesInstanceUid, ...mappedParams } =
            mapParams(origParams, {
              supportsFuzzyMatching: _dicomWebConfig.supportsFuzzyMatching,
              supportsWildcard: _dicomWebConfig.supportsWildcard,
            }) || {};

          const results = await qidoSearch(
            _qidoDicomWebClient,
            undefined,
            undefined,
            mappedParams
          );

          return processResults(results);
        },
        processResults: processResults.bind(),
      },
      series: {
        // mapParams: mapParams.bind(),
        search: async function(studyInstanceUid) {
          const headers = userAuthenticationService.getAuthorizationHeader();
          if (headers) {
            _qidoDicomWebClient.headers = headers;
          }

          const results = await seriesInStudy(
            _qidoDicomWebClient,
            studyInstanceUid
          );

          return processSeriesResults(results);
        },
        // processResults: processResults.bind(),
      },
      instances: {
        search: (studyInstanceUid, queryParameters) => {
          const headers = userAuthenticationService.getAuthorizationHeader();
          if (headers) {
            _qidoDicomWebClient.headers = headers;
          }

          qidoSearch.call(
            undefined,
            _qidoDicomWebClient,
            studyInstanceUid,
            null,
            queryParameters
          );
        },
      },
    },
    retrieve: {
      /**
       * Generates a URL that can be used for direct retrieve of the bulkdata
       *
       * @param {object} params
       * @param {string} params.tag is the tag name of the URL to retrieve
       * @param {object} params.instance is the instance object that the tag is in
       * @param {string} params.defaultType is the mime type of the response
       * @param {string} params.singlepart is the type of the part to retrieve
       * @returns an absolute URL to the resource, if the absolute URL can be retrieved as singlepart,
       *    or is already retrieved, or a promise to a URL for such use if a BulkDataURI
       */
      directURL: params => {
        return getDirectURL(_wadoDicomWebClient.wadoRoot, params);
      },
      series: {
        metadata: async ({
          StudyInstanceUID,
          filters,
          sortCriteria,
          sortFunction,
          madeInClient = false,
          withCredentials = !!webConfig.withCredentials,
        } = {}) => {
          const headers = userAuthenticationService.getAuthorizationHeader();
          if (headers) {
            _wadoDicomWebClient.headers = headers;
          }

          if (!StudyInstanceUID) {
            throw new Error(
              'Unable to query for SeriesMetadata without StudyInstanceUID'
            );
          }

          if (_dicomWebConfig.enableStudyLazyLoad) {
            return implementation._retrieveSeriesMetadataAsync(
              StudyInstanceUID,
              filters,
              sortCriteria,
              sortFunction,
              madeInClient,
              withCredentials
            );
          }

          return implementation._retrieveSeriesMetadataSync(
            StudyInstanceUID,
            filters,
            sortCriteria,
            sortFunction,
            madeInClient,
            withCredentials
          );
        },
      },
    },

    store: {
      dicom: async dataset => {
        const headers = userAuthenticationService.getAuthorizationHeader();
        if (headers) {
          _wadoDicomWebClient.headers = headers;
        }

        const meta = {
          FileMetaInformationVersion:
            dataset._meta.FileMetaInformationVersion.Value,
          MediaStorageSOPClassUID: dataset.SOPClassUID,
          MediaStorageSOPInstanceUID: dataset.SOPInstanceUID,
          TransferSyntaxUID: EXPLICIT_VR_LITTLE_ENDIAN,
          ImplementationClassUID,
          ImplementationVersionName,
        };

        const denaturalized = denaturalizeDataset(meta);
        const dicomDict = new DicomDict(denaturalized);

        dicomDict.dict = denaturalizeDataset(dataset);

        const part10Buffer = dicomDict.write();

        const options = {
          datasets: [part10Buffer],
        };

        await _wadoDicomWebClient.storeInstances(options);
      },
    },
    _retrieveSeriesMetadataSync: async (
      StudyInstanceUID,
      filters,
      sortCriteria,
      sortFunction,
      madeInClient,
      withCredentials
    ) => {
      const enableStudyLazyLoad = false;

      // data is all SOPInstanceUIDs
      const data = await retrieveStudyMetadata(
        _wadoDicomWebClient,
        StudyInstanceUID,
        enableStudyLazyLoad,
        filters,
        sortCriteria,
        sortFunction,
        withCredentials
      );

      // first naturalize the data
      const naturalizedInstancesMetadata = data.map(naturalizeDataset);

      const seriesSummaryMetadata = {};
      const instancesPerSeries = {};

      naturalizedInstancesMetadata.forEach(instance => {
        if (!seriesSummaryMetadata[instance.SeriesInstanceUID]) {
          seriesSummaryMetadata[instance.SeriesInstanceUID] = {
            StudyInstanceUID: instance.StudyInstanceUID,
            StudyDescription: instance.StudyDescription,
            SeriesInstanceUID: instance.SeriesInstanceUID,
            SeriesDescription: instance.SeriesDescription,
            SeriesNumber: instance.SeriesNumber,
            SeriesTime: instance.SeriesTime,
            SOPClassUID: instance.SOPClassUID,
            ProtocolName: instance.ProtocolName,
            Modality: instance.Modality,
          };
        }

        if (!instancesPerSeries[instance.SeriesInstanceUID]) {
          instancesPerSeries[instance.SeriesInstanceUID] = [];
        }

        const imageId = implementation.getImageIdsForInstance({
          instance,
        });

        instance.imageId = imageId;

        metadataProvider.addImageIdToUIDs(imageId, {
          StudyInstanceUID,
          SeriesInstanceUID: instance.SeriesInstanceUID,
          SOPInstanceUID: instance.SOPInstanceUID,
        });

        instancesPerSeries[instance.SeriesInstanceUID].push(instance);
      });

      // grab all the series metadata
      const seriesMetadata = Object.values(seriesSummaryMetadata);
      DicomMetadataStore.addSeriesMetadata(seriesMetadata, madeInClient);

      Object.keys(instancesPerSeries).forEach(seriesInstanceUID =>
        DicomMetadataStore.addInstances(
          instancesPerSeries[seriesInstanceUID],
          madeInClient
        )
      );
    },

    _retrieveSeriesMetadataAsync: async (
      StudyInstanceUID,
      filters,
      sortCriteria,
      sortFunction,
      madeInClient = false,
      withCredentials = false
    ) => {
      const enableStudyLazyLoad = true;
      // Get Series
      const {
        preLoadData: seriesSummaryMetadata,
        promises: seriesPromises,
      } = await retrieveStudyMetadata(
        _wadoDicomWebClient,
        StudyInstanceUID,
        enableStudyLazyLoad,
        filters,
        sortCriteria,
        sortFunction,
        withCredentials
      );

      /**
       * naturalizes the dataset, and adds a retrieve bulkdata method
       * to any values containing BulkDataURI.
       * @param {*} instance
       * @returns naturalized dataset, with retrieveBulkData methods
       */
      const addRetrieveBulkData = instance => {
        const naturalized = naturalizeDataset(instance);
        Object.keys(naturalized).forEach(key => {
          const value = naturalized[key];
          // The value.Value will be set with the bulkdata read value
          // in which case it isn't necessary to re-read this.
          if (value && value.BulkDataURI && !value.Value) {
            // Provide a method to fetch bulkdata
            value.retrieveBulkData = () => {
              const options = {
                // The bulkdata fetches work with either multipart or
                // singlepart, so set multipart to false to let the server
                // decide which type to respond with.
                multipart: false,
                BulkDataURI: value.BulkDataURI,
                // The study instance UID is required if the bulkdata uri
                // is relative - that isn't disallowed by DICOMweb, but
                // isn't well specified in the standard, but is needed in
                // any implementation that stores static copies of the metadata
                StudyInstanceUID: naturalized.StudyInstanceUID,
              };
              return _qidoDicomWebClient.retrieveBulkData(options).then(val => {
                const ret = (val && val[0]) || undefined;
                value.Value = ret;
                return ret;
              });
            };
          }
        });
        return naturalized;
      };

      // Async load series, store as retrieved
      function storeInstances(instances) {
        const naturalizedInstances = instances.map(addRetrieveBulkData);

        // Adding instanceMetadata to OHIF MetadataProvider
        naturalizedInstances.forEach((instance, index) => {
          const imageId = implementation.getImageIdsForInstance({
            instance,
          });

          // Adding imageId to each instance
          // Todo: This is not the best way I can think of to let external
          // metadata handlers know about the imageId that is stored in the store
          instance.imageId = imageId;

          // Adding UIDs to metadataProvider
          // Note: storing imageURI in metadataProvider since stack viewports
          // will use the same imageURI
          metadataProvider.addImageIdToUIDs(imageId, {
            StudyInstanceUID,
            SeriesInstanceUID: instance.SeriesInstanceUID,
            SOPInstanceUID: instance.SOPInstanceUID,
          });
        });

        DicomMetadataStore.addInstances(naturalizedInstances, madeInClient);
      }

      function setSuccessFlag() {
        const study = DicomMetadataStore.getStudy(
          StudyInstanceUID,
          madeInClient
        );
        study.isLoaded = true;
      }

      // Google Cloud Healthcare doesn't return StudyInstanceUID, so we need to add
      // it manually here
      seriesSummaryMetadata.forEach(aSeries => {
        aSeries.StudyInstanceUID = StudyInstanceUID;
      });

      DicomMetadataStore.addSeriesMetadata(seriesSummaryMetadata, madeInClient);

      const seriesDeliveredPromises = seriesPromises.map(promise =>
        promise.then(instances => {
          storeInstances(instances);
        })
      );
      await Promise.allSettled(seriesDeliveredPromises);
      setSuccessFlag();
    },
    deleteStudyMetadataPromise,
    async getImageIdsForStudy(StudyInstanceUID) {
      const seriesMetadata = await this.query.series.search(StudyInstanceUID);
      const seriesDatasets = await Promise.all(
        seriesMetadata.map(seriesMetadata =>
          _wadoDicomWebClient.retrieveSeriesMetadata({
            studyInstanceUID: StudyInstanceUID,
            seriesInstanceUID: seriesMetadata.seriesInstanceUid,
          })
        )
      );
      return seriesDatasets.map(instances => {
        const naturalizedInstance = instances.map(naturalizeDataset);
        return this.getImageIdsForDisplaySet({
          images: naturalizedInstance,
        });
      });
    },
    getImageIdsForDisplaySet(displaySet) {
      const images = displaySet.images;
      const imageIds = [];

      if (!images) {
        return imageIds;
      }

      displaySet.images.forEach(instance => {
        const NumberOfFrames = instance.NumberOfFrames;

        let startIndex = 1;
        let endIndex = NumberOfFrames;

        const multiFrameImagesMapper = displaySet.getAttribute('multiFrameImagesMapper');
        if (
          multiFrameImagesMapper &&
          multiFrameImagesMapper instanceof Function
        ) {
          startIndex = multiFrameImagesMapper().startIndex;
          endIndex = multiFrameImagesMapper().endIndex;
        }

        if (NumberOfFrames > 1) {
          for (let frame = startIndex; frame <= endIndex; frame++) {
            const imageId = this.getImageIdsForInstance({
              instance,
              frame,
            });
            imageIds.push(imageId);
          }
        } else {
          const imageId = this.getImageIdsForInstance({ instance });
          imageIds.push(imageId);
        }
      });

      return imageIds;
    },
    getImageIdsForInstance({ instance, frame }) {
      const imageIds = getImageId({
        instance,
        frame,
        config: _dicomWebConfig,
      });
      return imageIds;
    },
  };

  if (_dicomWebConfig.supportsReject) {
    implementation.reject = dcm4cheeReject(_dicomWebConfig.wadoRoot);
  }

  return IWebApiDataSource.create(implementation);
}

export { createDicomWebApi };
