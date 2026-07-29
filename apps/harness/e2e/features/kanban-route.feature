Feature: View the work pipeline
  Operators use the dedicated Kanban route to monitor delivery without
  repository management competing with the pipeline.

  Scenario: View the empty work pipeline
    When I navigate to the Kanban board
    Then all six pipeline lane headers are visible
    And the Pipeline jobs tab is active
    And repository management is not rendered
    And the committed pull request totals are visible above the board

  Scenario: Switch from Home to Kanban via top nav
    When I open the Home dashboard
    Then the Home top nav control is active
    And the Kanban top nav control is not active
    When I click the Kanban top nav control
    Then I am on the Kanban board
    And all six pipeline lane headers are visible
    And the Kanban top nav control is active
    And the Home top nav control is not active

  Scenario: Switch from Kanban to Home via top nav
    When I navigate to the Kanban board
    Then the Kanban top nav control is active
    And the Home top nav control is not active
    When I click the Home top nav control
    Then I am on the Home dashboard
    And the Home top nav control is active
    And the Kanban top nav control is not active
