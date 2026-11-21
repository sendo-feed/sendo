//! 実ページから `scripts/skeletonize-page.ts` で機械的に作った骨組み。

fn assert_extracts_body(html: &[u8]) {
    let result = sendo_extract::extract(
        html,
        Some("text/html; charset=utf-8"),
        "https://example.com/article.html",
    )
    .expect("本文を抽出できる");
    assert!(result.text_length > 0);
    assert!(!result.html.trim().is_empty());
}

#[test]
fn extracts_body_from_lead_embeds_1() {
    assert_extracts_body(include_bytes!("fixtures/lead-embeds-1.html"));
}

#[test]
fn extracts_body_from_lead_embeds_2() {
    assert_extracts_body(include_bytes!("fixtures/lead-embeds-2.html"));
}

macro_rules! candidate_fixture {
    ($test:ident, $path:literal) => {
        #[test]
        fn $test() {
            assert_extracts_body(include_bytes!(concat!("fixtures/", $path)));
        }
    };
}

candidate_fixture!(extracts_body_from_candidate_03, "candidate-03.html");
candidate_fixture!(extracts_body_from_candidate_04, "candidate-04.html");
candidate_fixture!(extracts_body_from_candidate_06, "candidate-06.html");
candidate_fixture!(extracts_body_from_candidate_07, "candidate-07.html");
candidate_fixture!(extracts_body_from_candidate_08, "candidate-08.html");
candidate_fixture!(extracts_body_from_candidate_09, "candidate-09.html");
candidate_fixture!(extracts_body_from_candidate_10, "candidate-10.html");
candidate_fixture!(extracts_body_from_candidate_11, "candidate-11.html");
candidate_fixture!(extracts_body_from_candidate_12, "candidate-12.html");
candidate_fixture!(extracts_body_from_candidate_13, "candidate-13.html");
candidate_fixture!(extracts_body_from_candidate_14, "candidate-14.html");
candidate_fixture!(extracts_body_from_candidate_15, "candidate-15.html");
candidate_fixture!(extracts_body_from_candidate_16, "candidate-16.html");
candidate_fixture!(extracts_body_from_candidate_17, "candidate-17.html");
candidate_fixture!(extracts_body_from_candidate_18, "candidate-18.html");
candidate_fixture!(extracts_body_from_candidate_19, "candidate-19.html");
candidate_fixture!(extracts_body_from_candidate_20, "candidate-20.html");
candidate_fixture!(extracts_body_from_candidate_21, "candidate-21.html");
candidate_fixture!(extracts_body_from_candidate_22, "candidate-22.html");
candidate_fixture!(extracts_body_from_candidate_25, "candidate-25.html");
candidate_fixture!(extracts_body_from_candidate_27, "candidate-27.html");
candidate_fixture!(extracts_body_from_candidate_29, "candidate-29.html");
candidate_fixture!(extracts_body_from_candidate_30, "candidate-30.html");
candidate_fixture!(extracts_body_from_candidate_31, "candidate-31.html");
candidate_fixture!(extracts_body_from_candidate_32, "candidate-32.html");
candidate_fixture!(extracts_body_from_candidate_33, "candidate-33.html");
candidate_fixture!(extracts_body_from_candidate_34, "candidate-34.html");
candidate_fixture!(extracts_body_from_candidate_35, "candidate-35.html");
candidate_fixture!(extracts_body_from_candidate_36, "candidate-36.html");
candidate_fixture!(extracts_body_from_candidate_37, "candidate-37.html");
candidate_fixture!(extracts_body_from_candidate_38, "candidate-38.html");
candidate_fixture!(extracts_body_from_candidate_39, "candidate-39.html");
candidate_fixture!(extracts_body_from_candidate_40, "candidate-40.html");
candidate_fixture!(extracts_body_from_candidate_41, "candidate-41.html");
candidate_fixture!(extracts_body_from_candidate_42, "candidate-42.html");
candidate_fixture!(extracts_body_from_candidate_43, "candidate-43.html");
candidate_fixture!(extracts_body_from_candidate_44, "candidate-44.html");
candidate_fixture!(extracts_body_from_candidate_45, "candidate-45.html");
candidate_fixture!(extracts_body_from_candidate_46, "candidate-46.html");
candidate_fixture!(extracts_body_from_candidate_47, "candidate-47.html");
candidate_fixture!(extracts_body_from_candidate_48, "candidate-48.html");
candidate_fixture!(extracts_body_from_candidate_49, "candidate-49.html");
candidate_fixture!(extracts_body_from_candidate_50, "candidate-50.html");
