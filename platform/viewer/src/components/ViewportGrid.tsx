import React, { useEffect, useCallback } from 'react';
import PropTypes from 'prop-types';
import { ServicesManager, Types } from '@ohif/core';
import { ViewportGrid, ViewportPane, useViewportGrid } from '@ohif/ui';
import { utils } from '@ohif/core';
import EmptyViewport from './EmptyViewport';
import classNames from 'classnames';
import { commandsManager } from '../App';

const { isEqualWithin } = utils;

const ORIENTATION_MAP = {
  axial: {
    viewPlaneNormal: [0, 0, -1],
    viewUp: [0, -1, 0],
  },
  sagittal: {
    viewPlaneNormal: [1, 0, 0],
    viewUp: [0, 0, 1],
  },
  coronal: {
    viewPlaneNormal: [0, 1, 0],
    viewUp: [0, 0, 1],
  },
};

const compareViewportOptions = (opts1, opts2) => {
  if ((opts1.viewportType || 'stack') != opts2.viewportType) {
    return false;
  }
  return true;
};

function ViewerViewportGrid(props) {
  const {
    servicesManager,
    viewportComponents,
    dataSource,
    modeViewportPaneStyles = () => { },
  } = props;
  const [viewportGrid, viewportGridService] = useViewportGrid();

  const { layout, activeViewportIndex, viewports } = viewportGrid;
  const { numCols, numRows } = layout;

  // TODO -> Need some way of selecting which displaySets hit the viewports.
  const {
    displaySetService,
    measurementService,
    hangingProtocolService,
    uiNotificationService,
  } = (servicesManager as ServicesManager).services;

  /**
   * This callback runs after the viewports structure has changed in any way.
   * On initial display, that means if it has changed by applying a HangingProtocol,
   * while subsequently it may mean by changing the stage or by manually adjusting
   * the layout.

   */
  const updateDisplaySetsFromProtocol = (
    protocol: Types.HangingProtocol.Protocol,
    stage,
    activeStudyUID,
    viewportMatchDetails
  ) => {
    const availableDisplaySets = displaySetService.getActiveDisplaySets();

    if (!availableDisplaySets.length) {
      console.log('No available display sets', availableDisplaySets);
      return;
    }

    // Match each viewport individually
    const { layoutType } = stage.viewportStructure;
    const stageProps = stage.viewportStructure.properties;
    const { columns: numCols, rows: numRows, layoutOptions = [] } = stageProps;

    /**
     * This find or create viewport uses the hanging protocol results to
     * specify the viewport match details, which specifies the size and
     * setup of the various viewports.
     */
    const findOrCreateViewport = viewportIndex => {
      const details = viewportMatchDetails.get(viewportIndex);
      if (!details) {
        console.log('No match details for viewport', viewportIndex);
        return;
      }

      const { displaySetsInfo, viewportOptions } = details;
      const displaySetUIDsToHang = [];
      const displaySetUIDsToHangOptions = [];

      displaySetsInfo.forEach(
        ({ displaySetInstanceUID, displaySetOptions }) => {
          if (displaySetInstanceUID) {
            displaySetUIDsToHang.push(displaySetInstanceUID);
          }

          displaySetUIDsToHangOptions.push(displaySetOptions);
        }
      );

      return {
        displaySetInstanceUIDs: displaySetUIDsToHang,
        displaySetOptions: displaySetUIDsToHangOptions,
        viewportOptions: {
          ...viewportOptions,
        },
      };
    };

    viewportGridService.setLayout({
      numRows,
      numCols,
      layoutType,
      layoutOptions,
      findOrCreateViewport,
    });
  };

  const _getUpdatedViewports = useCallback(
    (viewportIndex, displaySetInstanceUID) => {
      let updatedViewports = [];
      try {
        updatedViewports = hangingProtocolService.getViewportsRequireUpdate(
          viewportIndex,
          displaySetInstanceUID
        );
      } catch (error) {
        console.warn(error);
        uiNotificationService.show({
          title: 'Drag and Drop',
          message:
            'The selected display sets could not be added to the viewport due to a mismatch in the Hanging Protocol rules.',
          type: 'info',
          duration: 3000,
        });
      }

      return updatedViewports;
    },
    [hangingProtocolService, uiNotificationService]
  );

  // Using Hanging protocol engine to match the displaySets
  useEffect(() => {
    const { unsubscribe } = hangingProtocolService.subscribe(
      hangingProtocolService.EVENTS.PROTOCOL_CHANGED,
      ({ protocol, stage, activeStudyUID, viewportMatchDetails }) => {
        updateDisplaySetsFromProtocol(
          protocol,
          stage,
          activeStudyUID,
          viewportMatchDetails
        );
      }
    );

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const { unsubscribe } = measurementService.subscribe(
      measurementService.EVENTS.JUMP_TO_MEASUREMENT,
      ({ viewportIndex, measurement }) => {
        const {
          displaySetInstanceUID: referencedDisplaySetInstanceUID,
          metadata: { viewPlaneNormal },
        } = measurement;

        // if we already have the displaySet in one of the viewports
        // Todo: handle fusion display sets?
        for (const viewport of viewports) {
          const isMatch = viewport.displaySetInstanceUIDs.includes(
            referencedDisplaySetInstanceUID
          );
          if (isMatch) {
            return;
          }
        }

        const displaySet = displaySetService.getDisplaySetByUID(
          referencedDisplaySetInstanceUID
        );

        let imageIndex;
        // jump straight to the initial image index if we can
        if (displaySet.images && measurement.SOPInstanceUID) {
          imageIndex = displaySet.images.findIndex(
            image => image.SOPInstanceUID === measurement.SOPInstanceUID
          );
        }

        const updatedViewports = _getUpdatedViewports(
          viewportIndex,
          referencedDisplaySetInstanceUID
        );

        if (!updatedViewports || !updatedViewports.length) {
          return;
        }

        updatedViewports.forEach(vp => {
          const { orientation, viewportType } = vp.viewportOptions;
          let initialImageOptions;

          // For initial imageIndex to hang be careful for the volume viewport
          if (viewportType === 'stack') {
            initialImageOptions = {
              index: imageIndex,
            };
          } else if (viewportType === 'volume') {
            // For the volume viewports, be careful to not jump in the viewports
            // that are not in the same orientation.
            // Todo: this doesn't work for viewports that have custom orientation
            // vectors specified
            if (
              orientation &&
              viewPlaneNormal &&
              isEqualWithin(
                ORIENTATION_MAP[orientation]?.viewPlaneNormal,
                viewPlaneNormal
              )
            ) {
              initialImageOptions = {
                index: imageIndex,
              };
            }
          }

          vp.viewportOptions['initialImageOptions'] = initialImageOptions;
        });

        viewportGridService.setDisplaySetsForViewports(updatedViewports);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [viewports]);

  /**
  const onDoubleClick = viewportIndex => {
    // TODO -> Disabled for now.
    // onNewImage on a cornerstone viewport is firing setDisplaySetsForViewport.
    // Which it really really shouldn't. We need a larger fix for jump to
    // measurements and all cornerstone "imageIndex" state to fix this.
    if (cachedLayout) {
      viewportGridService.set({
        numCols: cachedLayout.numCols,
        numRows: cachedLayout.numRows,
        activeViewportIndex: cachedLayout.activeViewportIndex,
        viewports: cachedLayout.viewports,
        cachedLayout: null,
      });

      return;
    }

    const cachedViewports = viewports.map(viewport => {
      return {
        displaySetInstanceUID: viewport.displaySetInstanceUID,
      };
    });

    viewportGridService.set({
      numCols: 1,
      numRows: 1,
      activeViewportIndex: 0,
      viewports: [
        {
          displaySetInstanceUID: viewports[viewportIndex].displaySetInstanceUID,
          imageIndex: undefined,
        },
      ],
      cachedLayout: {
        numCols,
        numRows,
        viewports: cachedViewports,
        activeViewportIndex: viewportIndex,
      },
    });
  };
  */

  const onDropHandler = (viewportIndex, { displaySetInstanceUID }) => {
    const updatedViewports = _getUpdatedViewports(
      viewportIndex,
      displaySetInstanceUID
    );
    viewportGridService.setDisplaySetsForViewports(updatedViewports);
  };

  const handleReload = () => {
    const { ExternalInterfaceService } = servicesManager.services;
    if (ExternalInterfaceService.reloadStudy) {
      ExternalInterfaceService.reloadStudy();
    } else {
      console.log('No reload function registeted in external service');
    }
  };

  const getViewportPanes = useCallback(() => {
    const viewportPanes = [];

    const numViewportPanes = viewportGridService.getNumViewportPanes();
    let readyViewports = 0;
    const checkReady = () => {
      readyViewports = readyViewports + 1;
      if (readyViewports === numViewportPanes) {
        const layoutLoaded = hangingProtocolService?.protocol?.callbacks?.onLayoutViewportDataContainersLoaded;
        if (layoutLoaded) {
          commandsManager.run(layoutLoaded)
        }
      }
    }

    for (let i = 0; i < numViewportPanes; i++) {
      const viewportIndex = i;
      const isActive = activeViewportIndex === viewportIndex;
      const paneMetadata = viewports[i] || {};
      const viewportId = paneMetadata.viewportId || `viewport-${i}`;
      if (!paneMetadata.viewportId) {
        paneMetadata.viewportId = viewportId;
      }
      const {
        displaySetInstanceUIDs,
        viewportOptions,
        displaySetOptions, // array of options for each display set in the viewport
        x: viewportX,
        y: viewportY,
        width: viewportWidth,
        height: viewportHeight,
        viewportLabel,
      } = paneMetadata;

      const displaySetInstanceUIDsToUse = displaySetInstanceUIDs || [];

      // This is causing the viewport components re-render when the activeViewportIndex changes
      const displaySets = displaySetInstanceUIDsToUse.map(
        displaySetInstanceUID => {
          return (
            displaySetService.getDisplaySetByUID(displaySetInstanceUID) || {}
          );
        }
      );

      const ViewportComponent = _getViewportComponent(
        displaySets,
        viewportComponents,
        uiNotificationService
      );

      // look inside displaySets to see if they need reRendering
      const displaySetsNeedsRerendering = displaySets.some(displaySet => {
        return displaySet.needsRerendering;
      });

      const onInteractionHandler = event => {
        if (isActive) return;
        if (event && event.type !== 'touchstart') {
          event.preventDefault();
          event.stopPropagation();
        }

        viewportGridService.setActiveViewportIndex(viewportIndex);
      };
      // TEMP -> Double click disabled for now
      // onDoubleClick={() => onDoubleClick(viewportIndex)}

      viewportPanes[i] = (
        <ViewportPane
          key={viewportId}
          acceptDropsFor="displayset"
          onDrop={onDropHandler.bind(null, viewportIndex)}
          onInteraction={onInteractionHandler}
          customStyle={{
            position: 'absolute',
            top: viewportY * 100 + 0.2 + '%',
            left: viewportX * 100 + 0.2 + '%',
            width: viewportWidth * 100 - 0.3 + '%',
            height: viewportHeight * 100 - 0.3 + '%',
            ...modeViewportPaneStyles({ numViewportPanes }),
          }}
          isActive={isActive}
        >
          <div
            data-cy="viewport-pane"
            className={classNames('h-full w-full flex flex-col')}
          >
            <ViewportComponent
              displaySets={displaySets}
              viewportIndex={viewportIndex}
              viewportLabel={viewports.length > 1 ? viewportLabel : ''}
              dataSource={dataSource}
              viewportOptions={viewportOptions}
              displaySetOptions={displaySetOptions}
              needsRerendering={displaySetsNeedsRerendering}
              onViewportDataLoad={checkReady}
              className="h-full w-full bg-black"
              handleReload={handleReload}
            />
          </div>
        </ViewportPane>
      );
    }

    return viewportPanes;
  }, [viewports, activeViewportIndex, viewportComponents, dataSource]);

  /**
   * Loading indicator until numCols and numRows are gotten from the HangingProtocolService
   */
  if (!numRows || !numCols) {
    return null;
  }

  return (
    <ViewportGrid numRows={numRows} numCols={numCols}>
      {/* {ViewportPanes} */}
      {getViewportPanes()}
    </ViewportGrid>
  );
}

ViewerViewportGrid.propTypes = {
  viewportComponents: PropTypes.array.isRequired,
  servicesManager: PropTypes.instanceOf(ServicesManager),
};

ViewerViewportGrid.defaultProps = {
  viewportComponents: [],
};

function _getViewportComponent(
  displaySets,
  viewportComponents,
  uiNotificationService
) {
  if (!displaySets || !displaySets.length) {
    return EmptyViewport;
  }

  // Todo: Do we have a viewport that has two different SOPClassHandlerIds?
  const SOPClassHandlerId = displaySets[0].SOPClassHandlerId;

  for (let i = 0; i < viewportComponents.length; i++) {
    if (!viewportComponents[i]) {
      throw new Error('viewport components not defined');
    }
    if (!viewportComponents[i].displaySetsToDisplay) {
      throw new Error('displaySetsToDisplay is null');
    }
    if (
      viewportComponents[i].displaySetsToDisplay.includes(SOPClassHandlerId)
    ) {
      const { component } = viewportComponents[i];
      return component;
    }
  }

  console.log("Can't show displaySet", SOPClassHandlerId, displaySets[0]);
  uiNotificationService.show({
    title: 'Viewport Not Supported Yet',
    message: `Cannot display SOPClassId of ${displaySets[0].SOPClassUID} yet`,
    type: 'error',
  });

  return EmptyViewport;
}

export default ViewerViewportGrid;
