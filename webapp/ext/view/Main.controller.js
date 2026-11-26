sap.ui.define([
    "sap/fe/core/PageController",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/core/format/DateFormat",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/export/Spreadsheet",
    "sap/ui/export/library"
], function (PageController, JSONModel, Filter, FilterOperator, DateFormat,
             MessageToast, MessageBox, Spreadsheet, exportLibrary) {
    "use strict";

    return PageController.extend("zgrnobd.ext.view.Main", {

        /* ==========================================
         * INIT  (local JSON model, same idea as 261E)
         * ======================================== */
        onInit: function () {
            PageController.prototype.onInit.apply(this, arguments);

            var oLocalModel = new JSONModel({
                selection: this._emptySelection(),
                batches: []
            });
            this.getView().setModel(oLocalModel, "local");
        },

        _emptySelection: function () {
            return {
                documentDate: new Date(),
                postingDate: new Date(),
                obdNumber: "",
                poNumber: "",
                deliveryNote: "",
                sloc: "",
                plant: "",
                unit: "",
                shift: "A",
                remark: "",
                recvQty: "0.000",
                scanQty: "0.000",
                recvBatches: 0,
                scanBatches: 0
            };
        },

        /* ==========================================
         * HELPERS
         * ======================================== */
        // "2026-11-23" -> Date (local time, no timezone shift)
        _toDate: function (sDate) {
            if (!sDate) { return new Date(); }
            var a = String(sDate).slice(0, 10).split("-");
            return new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2]));
        },

        // delivery numbers are 10 chars with leading zeros in SAP
        _padObd: function (s) {
            s = (s || "").trim();
            return /^\d+$/.test(s) ? s.padStart(10, "0") : s.toUpperCase();
        },

        _stripZeros: function (s) {
            return String(s || "").trim().toUpperCase().replace(/^0+/, "");
        },

        _focusScan: function () {
            var oInput = this.byId("batchInput");
            setTimeout(function () {
                if (oInput) { oInput.focus(); }
            }, 100);
        },

        /* ==========================================
         * OUTBOUND DELIVERY - F4 and change
         * ======================================== */
        onObdValueHelp: function () {
            this.byId("obdDialog").open();
        },

        onObdVHSearch: function (oEvent) {
            var sValue = oEvent.getParameter("value");
            var aFilters = [];
            if (sValue) {
                aFilters.push(new Filter("DeliveryDocument", FilterOperator.Contains, sValue));
            }
            oEvent.getSource().getBinding("items").filter(aFilters);
        },

        onObdVHConfirm: function (oEvent) {
            var oSelectedItem = oEvent.getParameter("selectedItem");
            if (oSelectedItem) {
                this._setObd(oSelectedItem.getTitle());
            }
        },

        onObdChange: function () {
            var sObd = this.getView().getModel("local").getProperty("/selection/obdNumber");
            if (!sObd || !sObd.trim()) {
                this._clearDelivery();
                return;
            }
            this._setObd(sObd);
        },

        _setObd: function (sObd) {
            var sPadded = this._padObd(sObd);
            this.getView().getModel("local").setProperty("/selection/obdNumber", sPadded);
            this._loadDelivery(sPadded);
        },

        _clearDelivery: function () {
            var oLocal = this.getView().getModel("local");
            oLocal.setProperty("/selection/poNumber", "");
            oLocal.setProperty("/selection/plant", "");
            oLocal.setProperty("/selection/unit", "");
            oLocal.setProperty("/batches", []);
            this._recalc();
        },

        _loadDelivery: function (sObd) {
            var oView = this.getView();
            var oModel = oView.getModel();
            var oLocal = oView.getModel("local");

            var oBinding = oModel.bindList("/ZI_GRN_OBD_HDR", null, null,
                [new Filter("DeliveryDocument", FilterOperator.EQ, sObd)], {
                    "$select": "DeliveryDocument,PurchaseOrder,Unit,DocumentDate,ReceivingPlant"
                });

            oView.setBusy(true);
            return oBinding.requestContexts(0, 1).then(function (aContexts) {
                if (aContexts.length === 0) {
                    this._clearDelivery();
                    MessageBox.error("Outbound delivery " + sObd +
                        " not found, has no batch items or is already fully received.");
                    return null;
                }

                var oH = aContexts[0].getObject();
                oLocal.setProperty("/selection/poNumber", oH.PurchaseOrder);
                oLocal.setProperty("/selection/plant", oH.ReceivingPlant);
                oLocal.setProperty("/selection/unit", oH.Unit);
                if (oH.DocumentDate) {
                    oLocal.setProperty("/selection/documentDate", this._toDate(oH.DocumentDate));
                }

                // default delivery note = delivery number (user can change it)
                var sNote = oLocal.getProperty("/selection/deliveryNote");
                if (!sNote || sNote === this._sLastObd) {
                    oLocal.setProperty("/selection/deliveryNote", sObd);
                }
                this._sLastObd = sObd;

                return this._loadBatches(sObd);
            }.bind(this)).catch(function (oError) {
                MessageBox.error("Error fetching delivery details: " + (oError.message || ""));
            }).finally(function () {
                oView.setBusy(false);
            });
        },

        // all OPEN batches of the delivery, status blank until scanned
        _loadBatches: function (sObd) {
            var oLocal = this.getView().getModel("local");
            var oModel = this.getView().getModel();

            var aFilters = [
                new Filter("DeliveryDocument", FilterOperator.EQ, sObd),
                new Filter("AlreadyReceived", FilterOperator.NE, "X")
            ];
            var oBinding = oModel.bindList("/ZI_GRN_OBD_BATCH", null, null, aFilters, {
                "$select": "DeliveryDocument,DeliveryDocumentItem,PurchaseOrder,PurchaseOrderItem," +
                           "ReceivingPlant,Material,ProductDescription,Batch,Qty,Unit,AlreadyReceived",
                "$orderby": "DeliveryDocumentItem"
            });

            return oBinding.requestContexts(0, 5000).then(function (aContexts) {
                var aRows = aContexts.map(function (oContext, i) {
                    var o = oContext.getObject();
                    return {
                        srNo:        i + 1,
                        obdItem:     o.DeliveryDocumentItem,
                        poNumber:    o.PurchaseOrder,
                        poItem:      o.PurchaseOrderItem,
                        plant:       o.ReceivingPlant,
                        batch:       o.Batch,
                        material:    o.Material,
                        description: o.ProductDescription,
                        qty:         o.Qty,
                        uom:         o.Unit,
                        status:      ""
                    };
                });
                oLocal.setProperty("/batches", aRows);
                this._recalc();

                if (aRows.length === 0) {
                    MessageBox.warning("No open batches found for outbound delivery " + sObd + ".");
                } else {
                    MessageToast.show("Scanner Ready: " + aRows.length + " batches to receive.");
                    this._focusScan();
                }
            }.bind(this));
        },

        /* ==========================================
         * TO STORAGE LOCATION - F4
         * ======================================== */
        onSlocValueHelp: function () {
            var sPlant = this.getView().getModel("local").getProperty("/selection/plant");
            if (!sPlant) {
                MessageToast.show("Please enter the outbound delivery first");
                return;
            }
            var oDialog = this.byId("slocDialog");
            oDialog.open();
            var oBinding = oDialog.getBinding("items");
            if (oBinding) {
                oBinding.filter([new Filter("Plant", FilterOperator.EQ, sPlant)]);
            }
        },

        onSlocVHSearch: function (oEvent) {
            var sValue = oEvent.getParameter("value");
            var sPlant = this.getView().getModel("local").getProperty("/selection/plant");
            var aFilters = [new Filter("Plant", FilterOperator.EQ, sPlant)];

            if (sValue) {
                aFilters.push(new Filter({
                    filters: [
                        new Filter("StorageLocation", FilterOperator.Contains, sValue),
                        new Filter("StorageLocationName", FilterOperator.Contains, sValue)
                    ],
                    and: false
                }));
            }
            oEvent.getSource().getBinding("items").filter(aFilters);
        },

        onSlocVHConfirm: function (oEvent) {
            var oSelectedItem = oEvent.getParameter("selectedItem");
            if (oSelectedItem) {
                this.getView().getModel("local").setProperty("/selection/sloc", oSelectedItem.getTitle());
            }
        },

        /* ==========================================
         * SCAN BATCH  (Enter key or Add button)
         * one or many batches separated by space / new line
         * ======================================== */
        onAddBatch: function () {
            var oInput = this.byId("batchInput");
            var oLocal = this.getView().getModel("local");
            var sInputValue = oInput.getValue().trim();

            if (!oLocal.getProperty("/selection/obdNumber")) {
                MessageBox.error("Enter the outbound delivery number first.");
                return;
            }
            if (!sInputValue) {
                MessageToast.show("Please enter or scan a batch.");
                this._focusScan();
                return;
            }

            var aRows = oLocal.getProperty("/batches") || [];
            var that = this;
            var iAdded = 0;
            var aNotInDelivery = [];
            var aDuplicates = [];

            sInputValue.split(/\s+/).forEach(function (sScanned) {
                if (!sScanned) { return; }

                // exact match first, then ignore leading zeros
                var oRow = aRows.find(function (r) { return r.batch === sScanned; }) ||
                           aRows.find(function (r) {
                               return that._stripZeros(r.batch) === that._stripZeros(sScanned);
                           });

                if (!oRow) {
                    aNotInDelivery.push(sScanned);          // SCENARIO 2
                } else if (oRow.status === "V") {
                    aDuplicates.push(sScanned);
                } else {
                    oRow.status = "V";                      // Verified
                    iAdded++;
                }
            });

            oLocal.setProperty("/batches", aRows);
            this._recalc();

            var sMessage = "";
            if (iAdded > 0) {
                sMessage += "Verified " + iAdded + " batch(es). ";
            }
            if (aNotInDelivery.length > 0) {
                sMessage += "\nBatch not part of outbound delivery " +
                    oLocal.getProperty("/selection/obdNumber") + ": " + aNotInDelivery.join(", ") + ".";
            }
            if (aDuplicates.length > 0) {
                sMessage += "\nBatch already scanned: " + aDuplicates.join(", ") + ".";
            }

            if (aNotInDelivery.length > 0) {
                MessageBox.error(sMessage.trim());
            } else if (aDuplicates.length > 0) {
                MessageBox.warning(sMessage.trim());
            } else {
                MessageToast.show(sMessage.trim());
            }

            oInput.setValue("");
            this._focusScan();
        },

        /* ==========================================
         * DELETE = set selected rows back to blank
         * ======================================== */
        onDeleteBatch: function () {
            var oLocal = this.getView().getModel("local");
            var oTable = this.byId("batchesTable");
            var aSelectedContexts = oTable.getSelectedContexts();

            if (aSelectedContexts.length === 0) {
                MessageToast.show("Please select at least one batch.");
                return;
            }

            aSelectedContexts.forEach(function (oContext) {
                oContext.getObject().status = "";
            });

            oLocal.setProperty("/batches", oLocal.getProperty("/batches"));
            oTable.removeSelections(true);
            this._recalc();
            MessageToast.show(aSelectedContexts.length + " batch(es) set back to blank.");
        },

        /* ==========================================
         * TOTALS  (Received = delivery, Scanned = verified)
         * ======================================== */
        _recalc: function () {
            var oLocal = this.getView().getModel("local");
            var aRows = oLocal.getProperty("/batches") || [];
            var fRecv = 0, fScan = 0, iScan = 0;

            aRows.forEach(function (r, i) {
                r.srNo = i + 1;
                fRecv += parseFloat(r.qty) || 0;
                if (r.status === "V") {
                    fScan += parseFloat(r.qty) || 0;
                    iScan++;
                }
            });

            oLocal.setProperty("/batches", aRows);
            oLocal.setProperty("/selection/recvBatches", aRows.length);
            oLocal.setProperty("/selection/scanBatches", iScan);
            oLocal.setProperty("/selection/recvQty", fRecv.toFixed(3));
            oLocal.setProperty("/selection/scanQty", fScan.toFixed(3));
        },

        /* ==========================================
         * SUBMIT
         * ======================================== */
        onSubmit: function () {
            var oLocal = this.getView().getModel("local");
            var oSel = oLocal.getProperty("/selection");

            if (!oSel.obdNumber || !oSel.sloc || !oSel.postingDate || !oSel.documentDate || !oSel.shift) {
                MessageBox.error("Please fill in all mandatory fields (dates, outbound delivery, to storage location, shift).");
                return;
            }
            if (oSel.scanBatches === 0) {
                MessageBox.error("Please scan at least one batch before submitting.");
                return;
            }

            // SCENARIO 1: fewer batches scanned than in the delivery -> NOTIFICATION
            if (oSel.scanBatches < oSel.recvBatches) {
                MessageBox.confirm(
                    "Notification: only " + oSel.scanBatches + " of " + oSel.recvBatches +
                    " batches are scanned.\nThe remaining batches stay open for a later GRN.\n\n" +
                    "Do you want to post now?", {
                        title: "Notification",
                        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                        emphasizedAction: MessageBox.Action.OK,
                        onClose: function (sAction) {
                            if (sAction === MessageBox.Action.OK) { this._post(); }
                        }.bind(this)
                    });
                return;
            }
            this._post();
        },

        _post: function () {
            var oView = this.getView();
            var oLocal = oView.getModel("local");
            var oODataModel = oView.getModel();
            var oSel = oLocal.getProperty("/selection");
            var aRows = oLocal.getProperty("/batches") || [];

            var oDateFormat = DateFormat.getDateInstance({ pattern: "yyyy-MM-dd" });

            // header + ALL rows (verified and blank) -> both stored in the custom tables
            var oPayload = {
                "ObdNumber":    oSel.obdNumber,
                "PoNumber":     oSel.poNumber,
                "DeliveryNote": oSel.deliveryNote || oSel.obdNumber,
                "DocumentDate": oDateFormat.format(oSel.documentDate),
                "PostingDate":  oDateFormat.format(oSel.postingDate),
                "Plant":        oSel.plant,
                "StorlocTo":    oSel.sloc,
                "Shift":        oSel.shift,
                "Remark":       oSel.remark || "",
                "Unit":         oSel.unit,
                "_Item": aRows.map(function (r) {
                    return {
                        "ObdNumber":  oSel.obdNumber,
                        "ObdItem":    r.obdItem,
                        "PoNumber":   r.poNumber,
                        "PoItem":     r.poItem,
                        "Plant":      r.plant,
                        "Batch":      r.batch,
                        "Material":   r.material,
                        "MatDes":     r.description,
                        "ScanStatus": r.status,
                        "Qty":        String(r.qty),
                        "Unit":       r.uom
                    };
                })
            };

            oView.setBusy(true);

            var oListBinding = oODataModel.bindList("/ZC_GRN_HD");
            var oContext = oListBinding.create(oPayload);

            oContext.created().then(function () {
                oView.setBusy(false);

                var sStatus = oContext.getProperty("Status");
                var sMessage = oContext.getProperty("Mess");
                var sMatDoc = oContext.getProperty("MatDoc");
                var sMatYear = oContext.getProperty("MatDocYear");

                if (sStatus === "S" && sMatDoc) {
                    MessageBox.success(
                        "GRN posted successfully!\n\n" +
                        "Material Document: " + sMatDoc + " / " + sMatYear + "\n\n" + sMessage, {
                            onClose: function () {
                                this._resetScreen();
                            }.bind(this)
                        });
                } else {
                    MessageBox.error(sMessage || "Submission failed: material document was not created.");
                }
            }.bind(this)).catch(function (oError) {
                oView.setBusy(false);
                console.error("Submission Error:", oError);
                MessageBox.error("Submission failed: \n\n" + (oError.message || "Failed to post data to the backend."));
            });
        },

        /* ==========================================
         * NEW
         * ======================================== */
        _resetScreen: function () {
            this._sLastObd = "";
            this.getView().getModel("local").setData({
                selection: this._emptySelection(),
                batches: []
            });
            var oInput = this.byId("inputObd");
            if (oInput) {
                setTimeout(function () { oInput.focus(); }, 100);
            }
        },

        onNew: function () {
            this._resetScreen();
            MessageToast.show("Screen cleared for a new entry.");
        },

        /* ==========================================
         * EXPORT TO EXCEL
         * ======================================== */
        onExportExcel: function () {
            var aRows = this.getView().getModel("local").getProperty("/batches");

            if (!aRows || aRows.length === 0) {
                MessageToast.show("There are no batches to export.");
                return;
            }

            var aData = aRows.map(function (r) {
                return Object.assign({}, r, { statusText: r.status === "V" ? "Verified" : "" });
            });

            var oSheet = new Spreadsheet({
                workbook: { columns: this._createColumnConfig() },
                dataSource: aData,
                fileName: "GRN_Batches.xlsx",
                worker: false
            });
            oSheet.build().finally(function () {
                oSheet.destroy();
            });
        },

        _createColumnConfig: function () {
            var EdmType = exportLibrary.EdmType;
            return [
                { label: "Sr. No.",              property: "srNo",        type: EdmType.Number },
                { label: "Batch",                property: "batch",       type: EdmType.String },
                { label: "Material",             property: "material",    type: EdmType.String },
                { label: "Material Description", property: "description", type: EdmType.String },
                { label: "Quantity",             property: "qty",         type: EdmType.Number },
                { label: "UoM",                  property: "uom",         type: EdmType.String },
                { label: "Batch Status",         property: "statusText",  type: EdmType.String }
            ];
        },

        /* ==========================================
         * FORMATTERS - Batch Status column
         * ======================================== */
        formatStatus: function (s) {
            return s === "V" ? "Verified" : "";
        },
        formatStatusState: function (s) {
            return s === "V" ? "Success" : "None";
        }
    });
});