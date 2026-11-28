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
         * INIT
         * mode: ""  = nothing loaded
         *       "OBD" = outbound delivery entered
         *       "INV" = invoice entered (many OBDs)
         * ======================================== */
        onInit: function () {
            PageController.prototype.onInit.apply(this, arguments);

            var oLocalModel = new JSONModel({
                mode: "",
                selection: this._emptySelection(),
                obds: [],
                batches: []
            });
            this.getView().setModel(oLocalModel, "local");

            // when user clicks / focuses the batch input -> check header first
            this.byId("batchInput").addEventDelegate({
                onfocusin: this._onBatchFocusIn
            }, this);
        },

        _emptySelection: function () {
            return {
                documentDate: new Date(),
                postingDate: new Date(),
                refNumber: "",          // OBD or Invoice typed by the user
                invoiceNumber: "",
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
        _toDate: function (sDate) {
            if (!sDate) { return new Date(); }
            var a = String(sDate).slice(0, 10).split("-");
            return new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2]));
        },

        // OBD and Invoice numbers are 10 chars with leading zeros in SAP
        _padNumber: function (s) {
            s = (s || "").trim();
            return /^\d+$/.test(s) ? s.padStart(10, "0") : s.toUpperCase();
        },

        _stripZeros: function (s) {
            return String(s || "").trim().toUpperCase().replace(/^0+/, "");
        },

        _focusControl: function (sId) {
            var oCtrl = this.byId(sId);
            setTimeout(function () {
                if (oCtrl) { oCtrl.focus(); }
            }, 100);
        },

        _focusScan: function () {
            this._focusControl("batchInput");
        },

        // after load: go to Sloc if it is empty, otherwise to scan field
        _focusAfterLoad: function () {
            var sSloc = this.getView().getModel("local").getProperty("/selection/sloc");
            this._focusControl(sSloc ? "batchInput" : "inputSloc");
        },

        /* ==========================================
         * HEADER VALIDATION
         * Marks missing fields red, shows one message,
         * focuses the first missing field.
         * returns true when header is complete.
         * ======================================== */
        _validateHeader: function () {
            var that = this;
            var oLocal = this.getView().getModel("local");
            var oSel = oLocal.getProperty("/selection");
            var bLoaded = !!oLocal.getProperty("/mode");

            var aChecks = [
                { id: "dpDocDate", ok: !!oSel.documentDate, text: "Document Date" },
                { id: "dpPostDate", ok: !!oSel.postingDate, text: "Posting Date" },
                {
                    id: "inputRef", ok: !!oSel.refNumber && bLoaded,
                    text: "OBD / Invoice Number (valid number)"
                },
                { id: "inputSloc", ok: !!oSel.sloc, text: "To Storage Location" },
                { id: "selectShift", ok: !!oSel.shift, text: "Shift" }
            ];

            var aMissing = [];
            aChecks.forEach(function (c) {
                that.byId(c.id).setValueState(c.ok ? "None" : "Error");
                if (!c.ok) { aMissing.push(c); }
            });

            if (aMissing.length === 0) { return true; }

            if (!this._bMsgOpen) {
                this._bMsgOpen = true;
                MessageBox.error(
                    "Please fill the header details first:\n\n- " +
                    aMissing.map(function (c) { return c.text; }).join("\n- "), {
                    onClose: function () {
                        // delay so the dialog's focus-restore does not re-trigger the check
                        setTimeout(function () {
                            that._bMsgOpen = false;
                            that.byId(aMissing[0].id).focus();
                        }, 200);
                    }
                });
            }
            return false;
        },

        _onBatchFocusIn: function () {
            if (this._bMsgOpen) { return; }
            this._validateHeader();
        },

        /* ==========================================
         * OBD / INVOICE - F4 and change
         * ======================================== */
        onRefValueHelp: function () {
            this.byId("refDialog").open();
        },

        onRefVHSearch: function (oEvent) {
            var sValue = oEvent.getParameter("value");
            var aFilters = [];
            if (sValue) {
                aFilters.push(new Filter({
                    filters: [
                        new Filter("DeliveryDocument", FilterOperator.Contains, sValue),
                        new Filter("BillingDocument", FilterOperator.Contains, sValue),
                        new Filter("PurchaseOrder", FilterOperator.Contains, sValue)
                    ],
                    and: false
                }));
            }
            oEvent.getSource().getBinding("items").filter(aFilters);
        },

        onRefVHConfirm: function (oEvent) {
            var oSelectedItem = oEvent.getParameter("selectedItem");
            if (oSelectedItem) {
                this._loadReference(oSelectedItem.getTitle());
            }
        },

        onRefChange: function () {
            var sRef = this.getView().getModel("local").getProperty("/selection/refNumber");
            if (!sRef || !sRef.trim()) {
                this._sLastRef = "";
                this._clearDelivery();
                return;
            }
            this._loadReference(sRef);
        },

        _clearDelivery: function () {
            var oLocal = this.getView().getModel("local");
            oLocal.setProperty("/mode", "");
            oLocal.setProperty("/selection/poNumber", "");
            oLocal.setProperty("/selection/invoiceNumber", "");
            oLocal.setProperty("/selection/plant", "");
            oLocal.setProperty("/selection/unit", "");
            oLocal.setProperty("/batches", []);
            this._recalc();
        },

        _requestHeaders: function (aFilters) {
            var oBinding = this.getView().getModel().bindList("/ZI_GRN_OBD_HDR", null, null, aFilters, {
                "$select": "DeliveryDocument,BillingDocument,PurchaseOrder,Unit,DocumentDate,ReceivingPlant"
            });
            return oBinding.requestContexts(0, 200).then(function (aContexts) {
                return aContexts.map(function (c) { return c.getObject(); });
            });
        },

        /* Try as OBD first; if not found, try as Invoice */
        _loadReference: async function (sRef) {
            var oView = this.getView();
            var oLocal = oView.getModel("local");
            var sPadded = this._padNumber(sRef);

            oLocal.setProperty("/selection/refNumber", sPadded);
            oView.setBusy(true);

            try {
                var sMode = "OBD";
                var aHdr = await this._requestHeaders(
                    [new Filter("DeliveryDocument", FilterOperator.EQ, sPadded)]);

                if (aHdr.length === 0) {
                    sMode = "INV";
                    aHdr = await this._requestHeaders(
                        [new Filter("BillingDocument", FilterOperator.EQ, sPadded)]);
                }

                if (aHdr.length === 0) {
                    this._clearDelivery();
                    MessageBox.error("OBD / Invoice " + sPadded +
                        " not found, has no batch items or is already fully received.");
                    return;
                }

                // unique OBDs and POs
                var aObds = [], aPos = [];
                aHdr.forEach(function (h) {
                    if (aObds.indexOf(h.DeliveryDocument) < 0) { aObds.push(h.DeliveryDocument); }
                    if (h.PurchaseOrder && aPos.indexOf(h.PurchaseOrder) < 0) { aPos.push(h.PurchaseOrder); }
                });

                var oH = aHdr[0];
                oLocal.setProperty("/mode", sMode);
                oLocal.setProperty("/selection/poNumber", aPos.length > 1 ? "Multiple" : (aPos[0] || ""));
                oLocal.setProperty("/selection/invoiceNumber",
                    sMode === "INV" ? sPadded : (oH.BillingDocument || ""));
                oLocal.setProperty("/selection/plant", oH.ReceivingPlant);
                oLocal.setProperty("/selection/unit", oH.Unit);
                if (oH.DocumentDate) {
                    oLocal.setProperty("/selection/documentDate", this._toDate(oH.DocumentDate));
                }

                // Delivery Note is NOT auto-filled any more - user enters it manually
                this._sLastRef = sPadded;

                await this._loadBatches(aObds, sMode, sPadded);
            } catch (oError) {
                MessageBox.error("Error fetching details: " + (oError.message || ""));
            } finally {
                oView.setBusy(false);
            }
        },

        // all OPEN batches of the OBD(s), status blank until scanned
        _loadBatches: function (aObds, sMode, sRef) {
            var oLocal = this.getView().getModel("local");
            var oModel = this.getView().getModel();

            var aFilters = [
                new Filter({
                    filters: aObds.map(function (d) {
                        return new Filter("DeliveryDocument", FilterOperator.EQ, d);
                    }),
                    and: false
                }),
                new Filter("AlreadyReceived", FilterOperator.NE, "X")
            ];

            var oBinding = oModel.bindList("/ZI_GRN_OBD_BATCH", null, null, aFilters, {
                "$select": "DeliveryDocument,DeliveryDocumentItem,PurchaseOrder,PurchaseOrderItem," +
                    "ReceivingPlant,Material,ProductDescription,Batch,Qty,Unit,AlreadyReceived",
                "$orderby": "DeliveryDocument,DeliveryDocumentItem"
            });

            return oBinding.requestContexts(0, 5000).then(function (aContexts) {
                var aRows = aContexts.map(function (oContext, i) {
                    var o = oContext.getObject();
                    return {
                        srNo: i + 1,
                        obd: o.DeliveryDocument,
                        obdItem: o.DeliveryDocumentItem,
                        poNumber: o.PurchaseOrder,
                        poItem: o.PurchaseOrderItem,
                        plant: o.ReceivingPlant,
                        batch: o.Batch,
                        material: o.Material,
                        description: o.ProductDescription,
                        qty: o.Qty,
                        uom: o.Unit,
                        status: ""
                    };
                });
                oLocal.setProperty("/batches", aRows);
                this._recalc();

                if (aRows.length === 0) {
                    MessageBox.warning("No open batches found for " +
                        (sMode === "INV" ? "invoice " : "outbound delivery ") + sRef + ".");
                } else {
                    MessageToast.show("Scanner Ready: " + aRows.length + " batches to receive.");
                    this._focusAfterLoad();
                }
            }.bind(this));
        },

        /* ==========================================
         * TO STORAGE LOCATION - F4
         * ======================================== */
        onSlocValueHelp: function () {
            var sPlant = this.getView().getModel("local").getProperty("/selection/plant");
            if (!sPlant) {
                MessageToast.show("Please enter the outbound delivery / invoice first");
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
                this.byId("inputSloc").setValueState("None");
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

            // header must be complete before any batch is added
            if (!this._validateHeader()) { return; }

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
                var aMatch = aRows.filter(function (r) { return r.batch === sScanned; });
                if (aMatch.length === 0) {
                    aMatch = aRows.filter(function (r) {
                        return that._stripZeros(r.batch) === that._stripZeros(sScanned);
                    });
                }

                if (aMatch.length === 0) {
                    aNotInDelivery.push(sScanned);
                    return;
                }
                // first not-yet-verified row (same batch can exist in 2 OBDs)
                var oRow = aMatch.find(function (r) { return r.status !== "V"; });
                if (!oRow) {
                    aDuplicates.push(sScanned);
                } else {
                    oRow.status = "V";
                    iAdded++;
                }
            });

            oLocal.setProperty("/batches", aRows);
            this._recalc();

            var sWhat = oLocal.getProperty("/mode") === "INV" ? "invoice " : "outbound delivery ";
            var sMessage = "";
            if (iAdded > 0) {
                sMessage += "Verified " + iAdded + " batch(es). ";
            }
            if (aNotInDelivery.length > 0) {
                sMessage += "\nBatch not part of " + sWhat +
                    oLocal.getProperty("/selection/refNumber") + ": " + aNotInDelivery.join(", ") + ".";
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
         * TOTALS + per-OBD summary table
         * ======================================== */
        _recalc: function () {
            var oLocal = this.getView().getModel("local");
            var aRows = oLocal.getProperty("/batches") || [];
            var fRecv = 0, fScan = 0, iScan = 0;
            var aObds = [], mObd = {};

            aRows.forEach(function (r, i) {
                r.srNo = i + 1;
                var fQty = parseFloat(r.qty) || 0;
                fRecv += fQty;

                var oO = mObd[r.obd];
                if (!oO) {
                    oO = mObd[r.obd] = {
                        obd: r.obd, po: r.poNumber, plant: r.plant,
                        recvQty: 0, scanQty: 0, recvBatches: 0, scanBatches: 0
                    };
                    aObds.push(oO);
                }
                oO.recvQty += fQty;
                oO.recvBatches++;

                if (r.status === "V") {
                    fScan += fQty;
                    iScan++;
                    oO.scanQty += fQty;
                    oO.scanBatches++;
                }
            });

            aObds.forEach(function (o, i) {
                o.srNo = i + 1;
                o.recvQtyText = o.recvQty.toFixed(3);
                o.scanQtyText = o.scanQty.toFixed(3);
                o.status = o.scanBatches === o.recvBatches ? "Verified"
                    : (o.scanBatches > 0 ? "In Progress" : "Pending");
            });

            oLocal.setProperty("/batches", aRows);
            oLocal.setProperty("/obds", aObds);
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

            if (!this._validateHeader()) { return; }

            if (oSel.scanBatches === 0) {
                MessageBox.error("Please scan at least one batch before submitting.");
                return;
            }

            // SCENARIO 1: fewer batches scanned than available -> NOTIFICATION
            if (oSel.scanBatches < oSel.recvBatches) {
                var aSkipped = (oLocal.getProperty("/obds") || [])
                    .filter(function (o) { return o.scanBatches === 0; })
                    .map(function (o) { return o.obd; });

                var sText = "Notification: only " + oSel.scanBatches + " of " + oSel.recvBatches +
                    " batches are scanned.\nThe remaining batches stay open for a later GRN.\n\n";
                if (aSkipped.length > 0) {
                    sText += "No GRN will be posted for OBD: " + aSkipped.join(", ") + "\n\n";
                }
                sText += "Do you want to post now?";

                MessageBox.confirm(sText, {
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

        /* One GRN (ZC_GRN_HD) per OBD that has at least one verified batch */
        _post: async function () {
            var oView = this.getView();
            var oLocal = oView.getModel("local");
            var oODataModel = oView.getModel();
            var oSel = oLocal.getProperty("/selection");
            var aRows = oLocal.getProperty("/batches") || [];
            var oDateFormat = DateFormat.getDateInstance({ pattern: "yyyy-MM-dd" });

            var aObdList = (oLocal.getProperty("/obds") || [])
                .filter(function (o) { return o.scanBatches > 0; })
                .map(function (o) { return o.obd; });

            var aDone = [];
            oView.setBusy(true);

            try {
                // for (var i = 0; i < aObdList.length; i++) {
                //     var sObd = aObdList[i];                         
                //     var sObdInt = this._padNumber(sObd);            
                //     var aObdRows = aRows.filter(function (r) { return r.obd === sObd; });
                //     var oFirst = aObdRows[0];    

                //     // header + ALL rows of this OBD (verified and blank)
                //     var oPayload = {
                //         "ObdNumber":    sObd,
                //         "PoNumber":     oFirst.poNumber,
                //         "DeliveryNote": oSel.deliveryNote || sObd,   
                //         "DocumentDate": oDateFormat.format(oSel.documentDate),
                //         "PostingDate":  oDateFormat.format(oSel.postingDate),
                //         "Plant":        oFirst.plant,
                //         "StorlocTo":    oSel.sloc,
                //         "Shift":        oSel.shift,
                //         "Remark":       oSel.remark || "",
                //         "Unit":         oFirst.uom,
                //         "_Item": aObdRows.map(function (r) {
                //             return {
                //                 "ObdNumber":  sObd,
                //                 "ObdItem":    r.obdItem,
                //                 "PoNumber":   r.poNumber,
                //                 "PoItem":     r.poItem,
                //                 "Plant":      r.plant,
                //                 "Batch":      r.batch,
                //                 "Material":   r.material,
                //                 "MatDes":     r.description,
                //                 "ScanStatus": r.status,
                //                 "Qty":        String(r.qty),
                //                 "Unit":       r.uom
                //             };
                //         })
                //     };

                for (var i = 0; i < aObdList.length; i++) {
                    var sObd = aObdList[i];
                    var sObdInt = this._padNumber(sObd);
                    var aObdRows = aRows.filter(function (r) { return r.obd === sObd; });
                    var oFirst = aObdRows[0];

                    var oPayload = {
                        "ObdNumber": sObdInt,
                        "PoNumber": this._padNumber(oFirst.poNumber),
                        "DeliveryNote": oSel.deliveryNote || sObdInt,
                        "DocumentDate": oDateFormat.format(oSel.documentDate),
                        "PostingDate": oDateFormat.format(oSel.postingDate),
                        "Plant": oFirst.plant,
                        "StorlocTo": oSel.sloc,
                        "Shift": oSel.shift,
                        "Remark": oSel.remark || "",
                        "Unit": oFirst.uom,
                        "_Item": aObdRows.map(function (r) {
                            return {
                                "ObdNumber": sObdInt,
                                "ObdItem": String(r.obdItem).padStart(6, "0"),
                                "PoNumber": this._padNumber(r.poNumber),
                                "PoItem": String(r.poItem).padStart(5, "0"),
                                "Plant": r.plant,
                                "Batch": r.batch,
                                "Material": r.material, 
                                "MatDes": r.description,
                                "ScanStatus": r.status,
                                "Qty": String(r.qty),
                                "Unit": r.uom
                            };
                        }.bind(this))
                    };

                    var oContext = oODataModel.bindList("/ZC_GRN_HD").create(oPayload);
                    await oContext.created();

                    var sStatus = oContext.getProperty("Status");
                    var sMessage = oContext.getProperty("Mess");
                    var sMatDoc = oContext.getProperty("MatDoc");
                    var sMatYear = oContext.getProperty("MatDocYear");

                    if (sStatus !== "S" || !sMatDoc) {
                        throw new Error("OBD " + sObd + ": " +
                            (sMessage || "material document was not created."));
                    }
                    aDone.push("OBD " + sObd + "  ->  Mat. Doc " + sMatDoc + " / " + sMatYear);
                }

                oView.setBusy(false);
                MessageBox.success("GRN posted successfully!\n\n" + aDone.join("\n"), {
                    onClose: function () { this._resetScreen(); }.bind(this)
                });

            } catch (oError) {
                oView.setBusy(false);
                console.error("Submission Error:", oError);

                var sErr = "Submission failed:\n\n" + (oError.message || "Failed to post data to the backend.");
                if (aDone.length > 0) {
                    sErr += "\n\nAlready posted:\n" + aDone.join("\n") +
                        "\n\nScreen is reloaded - remaining items are shown again.";
                    MessageBox.error(sErr);
                    this._loadReference(oSel.refNumber);   // posted OBDs drop out of the list
                } else {
                    MessageBox.error(sErr);
                }
            }
        },

        /* ==========================================
         * NEW
         * ======================================== */
        _resetScreen: function () {
            this._sLastRef = "";
            this.getView().getModel("local").setData({
                mode: "",
                selection: this._emptySelection(),
                obds: [],
                batches: []
            });
            ["dpDocDate", "dpPostDate", "inputRef", "inputSloc", "selectShift"].forEach(function (sId) {
                this.byId(sId).setValueState("None");
            }.bind(this));
            this._focusControl("inputRef");
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
                { label: "Sr. No.", property: "srNo", type: EdmType.Number },
                { label: "OBD Number", property: "obd", type: EdmType.String },
                { label: "Batch", property: "batch", type: EdmType.String },
                { label: "Material", property: "material", type: EdmType.String },
                { label: "Material Description", property: "description", type: EdmType.String },
                { label: "Quantity", property: "qty", type: EdmType.Number },
                { label: "UoM", property: "uom", type: EdmType.String },
                { label: "Batch Status", property: "statusText", type: EdmType.String }
            ];
        },

        /* ==========================================
         * FORMATTERS
         * ======================================== */
        formatStatus: function (s) {
            return s === "V" ? "Verified" : "";
        },
        formatStatusState: function (s) {
            return s === "V" ? "Success" : "None";
        },
        formatObdState: function (s) {
            return s === "Verified" ? "Success" : (s === "In Progress" ? "Warning" : "None");
        }
    });
});