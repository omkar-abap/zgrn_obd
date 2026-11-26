sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"zgrnobd/test/integration/pages/ZC_GRN_HDMain.gen"
], function (JourneyRunner, ZC_GRN_HDMainGenerated) {
    'use strict';

    const runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('zgrnobd') + '/test/flp.html#app-preview',
        pages: {
			onTheZC_GRN_HDMainGenerated: ZC_GRN_HDMainGenerated
        },
        async: true
    });

    return runner;
});

